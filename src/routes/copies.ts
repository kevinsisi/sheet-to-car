import { Router, Request, Response } from 'express';
import { getCars } from '../services/carInventory';
import {
  generateCopy, generateAllCopies, getCopies,
  publishCopy, unpublishCopy, deleteCopy, cleanExpiredCopies,
  setUserPreference, getAllPreferences, getTeamMembers, PLATFORMS,
  getPlatformPrompts,
} from '../services/copyGenerator';
import { getKeyCount } from '../services/geminiKeys';
import db from '../db/connection';

const router = Router();

// ── Batch task state (in-memory, survives page refresh) ──
let batchTask: {
  running: boolean;
  done: number;
  total: number;
  current: string;
  errors: string[];
  startedAt: string;
} = { running: false, done: 0, total: 0, current: '', errors: [], startedAt: '' };

// GET /api/copies/:item — get all copies for a car
router.get('/:item', (req: Request, res: Response) => {
  try {
    const copies = getCopies(req.params.item);
    return res.json({ copies, item: req.params.item });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/copies/:item/generate — generate copy for one or all platforms
router.post('/:item/generate', async (req: Request, res: Response) => {
  try {
    const { platform } = req.body; // optional: '官網' | '8891' | 'Facebook'
    const cars = await getCars();
    const car = cars.find(c => c.item === req.params.item);
    if (!car) return res.status(404).json({ error: `Car ${req.params.item} not found` });

    if (platform && PLATFORMS.includes(platform)) {
      const content = await generateCopy(car, platform);
      const copies = getCopies(req.params.item);
      return res.json({ content, copies, platform });
    } else {
      const results = await generateAllCopies(car);
      const copies = getCopies(req.params.item);
      return res.json({ results, copies });
    }
  } catch (err: any) {
    console.error('[copies] Generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/copies/:id/publish — set status to 上架 (7-day expiry)
router.patch('/:id/publish', (req: Request, res: Response) => {
  try {
    publishCopy(Number(req.params.id));
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/copies/:id/unpublish — set back to draft
router.patch('/:id/unpublish', (req: Request, res: Response) => {
  try {
    unpublishCopy(Number(req.params.id));
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/copies/:id
router.delete('/:id', (req: Request, res: Response) => {
  try {
    deleteCopy(Number(req.params.id));
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/copies/cleanup — manually trigger expired copy cleanup
router.post('/cleanup', (_req: Request, res: Response) => {
  const count = cleanExpiredCopies();
  return res.json({ cleaned: count });
});

// GET /api/copies/batch-status — check if batch is running + capacity info
router.get('/batch-status', (_req: Request, res: Response) => {
  const keys = getKeyCount();
  // Each car = 3 API calls (3 platforms). Conservative: max concurrent = keys / 3, min 1
  const maxSelect = Math.max(1, Math.min(Math.floor(keys / 3), 20));
  return res.json({ ...batchTask, maxSelect, keyCount: keys });
});

// POST /api/copies/batch-generate — scan 在庫 cars without copies and generate all
router.post('/batch-generate', async (req: Request, res: Response) => {
  if (batchTask.running) {
    return res.status(409).json({
      error: '已有批次任務進行中',
      ...batchTask,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const keys = getKeyCount();
  const maxByKeys = Math.max(1, Math.min(Math.floor(keys / 3), 20));
  const limit = Math.min(parseInt(req.query.limit as string) || 5, maxByKeys);
  const items: string[] = req.body?.items || [];

  batchTask = { running: true, done: 0, total: 0, current: '', errors: [], startedAt: new Date().toISOString() };

  try {
    const cars = await getCars();
    const inStock = cars.filter(c => c.status === '在庫');

    let needGen;
    if (items.length > 0) {
      needGen = inStock.filter(c => items.includes(c.item)).slice(0, limit);
    } else {
      needGen = [...inStock].reverse().filter(c => {
        const copies = getCopies(c.item);
        return copies.length === 0;
      }).slice(0, limit);
    }

    const totalAvailable = inStock.filter(c => getCopies(c.item).length === 0).length;
    batchTask.total = needGen.length;

    res.write(`data: ${JSON.stringify({ total: needGen.length, totalAvailable, phase: 'scan' })}\n\n`);

    for (const car of needGen) {
      try {
        batchTask.current = `${car.item} ${car.brand} ${car.model}`;
        res.write(`data: ${JSON.stringify({ item: car.item, brand: car.brand, model: car.model, status: 'generating', done: batchTask.done, total: needGen.length })}\n\n`);
        await generateAllCopies(car);
        batchTask.done++;
        res.write(`data: ${JSON.stringify({ item: car.item, status: 'done', done: batchTask.done, total: needGen.length })}\n\n`);
      } catch (err: any) {
        batchTask.done++;
        batchTask.errors.push(`${car.item}: ${err.message}`);
        res.write(`data: ${JSON.stringify({ item: car.item, status: 'error', error: err.message, done: batchTask.done, total: needGen.length })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ phase: 'complete', done: batchTask.done, total: needGen.length, remaining: totalAvailable - batchTask.done })}\n\n`);
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ phase: 'error', error: err.message })}\n\n`);
  }

  batchTask.running = false;
  batchTask.current = '';
  res.end();
});

// ── User Preferences ──

// GET /api/copies/preferences
router.get('/preferences/all', (_req: Request, res: Response) => {
  return res.json(getAllPreferences());
});

// PUT /api/copies/preferences
router.put('/preferences', (req: Request, res: Response) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  setUserPreference(key, value || '');
  return res.json({ success: true, key, value });
});

// ── Team Members ──

// GET /api/copies/team
router.get('/team/members', (_req: Request, res: Response) => {
  return res.json({ members: getTeamMembers() });
});

// ── Prompt Management ──

// GET /api/copies/prompt
router.get('/prompt/current', (_req: Request, res: Response) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").get() as any;
  const platformPrompts = getPlatformPrompts();
  return res.json({ prompt: row?.value || '', platformPrompts });
});

// PUT /api/copies/prompt
router.put('/prompt', (req: Request, res: Response) => {
  const { prompt } = req.body;
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('system_prompt', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(prompt || '');
  return res.json({ success: true });
});

export default router;
