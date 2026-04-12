import { Router, Request, Response } from 'express';
import { getCars, setPoPlatform } from '../services/carInventory';
import {
  generateAllCopies, getCopies, generateCopyWithMeta,
  publishCopy, unpublishCopy, deleteCopy, cleanExpiredCopies,
  setUserPreference, getAllPreferences, getTeamMembers, PLATFORMS,
  getPlatformPrompts, getCopyById,
} from '../services/copyGenerator';
import { assignBatchKeys, getKeyCount } from '../services/geminiKeys';
import db from '../db/connection';
import { getBuiltinPrompt } from '../prompts/promptLoader';

const router = Router();

const activeGenerationLocks = new Set<string>();

function getGenerationLockKey(item: string, platform: string): string {
  return `${item}::${platform}`;
}

function hasActiveGeneration(item: string): boolean {
  return PLATFORMS.some(platform => activeGenerationLocks.has(getGenerationLockKey(item, platform)))
    || activeGenerationLocks.has(getGenerationLockKey(item, '全部'));
}

function toPoPlatform(platform: string): 'official' | 'facebook' | '8891' | null {
  if (platform === '官網') return 'official';
  if (platform === 'Facebook') return 'facebook';
  if (platform === '8891') return '8891';
  return null;
}

// ── Batch task state (in-memory, survives page refresh) ──
let batchTask: {
  running: boolean;
  done: number;
  total: number;
  current: string;
  errors: string[];
  startedAt: string;
} = { running: false, done: 0, total: 0, current: '', errors: [], startedAt: '' };

// ══════════════════════════════════════════════════════
// IMPORTANT: All specific routes MUST come before /:item
// ══════════════════════════════════════════════════════

// GET /api/copies/batch-status
router.get('/batch-status', (_req: Request, res: Response) => {
  const keys = getKeyCount();
  const maxSelect = Math.max(1, Math.min(Math.floor(keys / 3), 20));
  return res.json({ ...batchTask, maxSelect, keyCount: keys });
});

// POST /api/copies/batch-generate
router.post('/batch-generate', async (req: Request, res: Response) => {
  if (batchTask.running) {
    return res.status(409).json({ error: '已有批次任務進行中', ...batchTask });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const keys = getKeyCount();
  const maxByKeys = Math.max(1, Math.min(Math.floor(keys / 3), 20));
  const limit = Math.min(parseInt(req.query.limit as string) || 5, maxByKeys);
  const items: string[] = req.body?.selectedItems || req.body?.items || [];

  batchTask = { running: true, done: 0, total: 0, current: '', errors: [], startedAt: new Date().toISOString() };

  try {
    const cars = await getCars();
    const inStock = cars.filter(c => c.status === '在庫');

    let needGen;
    if (items.length > 0) {
      needGen = inStock.filter(c => items.includes(c.item)).slice(0, limit);
    } else {
      needGen = [...inStock].reverse().filter(c => getCopies(c.item).length === 0).slice(0, limit);
    }

    const totalAvailable = inStock.filter(c => getCopies(c.item).length === 0).length;
    batchTask.total = needGen.length;
    const assignedKeys = assignBatchKeys(Math.max(1, needGen.length));

    res.write(`data: ${JSON.stringify({ total: needGen.length, totalAvailable, phase: 'scan' })}\n\n`);

    for (const [index, car] of needGen.entries()) {
      try {
        batchTask.current = `${car.item} ${car.brand} ${car.model}`;
        res.write(`data: ${JSON.stringify({ item: car.item, brand: car.brand, model: car.model, status: 'generating', done: batchTask.done, total: needGen.length })}\n\n`);
        const preferredApiKey = assignedKeys.length > 0 ? assignedKeys[index % assignedKeys.length] : undefined;
        const generated = await generateAllCopies(car, { preferredApiKey });
        batchTask.done++;
        const failedPlatforms = Object.keys(generated.errors);
        if (failedPlatforms.length > 0) {
          const error = `${car.item} 部分平台失敗: ${failedPlatforms.map(platform => `${platform}=${generated.errors[platform as keyof typeof generated.errors]}`).join(' | ')}`;
          batchTask.errors.push(error);
          res.write(`data: ${JSON.stringify({ item: car.item, status: 'partial_error', errors: generated.errors, done: batchTask.done, total: needGen.length })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ item: car.item, status: 'done', done: batchTask.done, total: needGen.length })}\n\n`);
        }
      } catch (err: any) {
        batchTask.done++;
        batchTask.errors.push(`${car.item}: ${err.message}`);
        res.write(`data: ${JSON.stringify({ item: car.item, status: 'error', error: err.message, done: batchTask.done, total: needGen.length })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ phase: 'complete', done: batchTask.done, total: needGen.length, remaining: totalAvailable - batchTask.done, errorCount: batchTask.errors.length })}\n\n`);
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ phase: 'error', error: err.message })}\n\n`);
  }

  batchTask.running = false;
  batchTask.current = '';
  res.end();
});

// POST /api/copies/cleanup
router.post('/cleanup', async (_req: Request, res: Response) => {
  const count = await cleanExpiredCopies();
  return res.json({ cleaned: count });
});

// GET /api/copies/preferences/all
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

// GET /api/copies/team/members
router.get('/team/members', (_req: Request, res: Response) => {
  return res.json({ members: getTeamMembers() });
});

// GET /api/copies/prompt/current
router.get('/prompt/current', (_req: Request, res: Response) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").get() as any;
  const platformPrompts = getPlatformPrompts();
  const platformPromptMeta = Object.fromEntries(
    Object.entries(platformPrompts).map(([platform, content]) => [
      platform,
      {
        isCustomized: content !== getBuiltinPrompt(platform),
        source: content !== getBuiltinPrompt(platform) ? 'user-override' : 'builtin',
      },
    ])
  );
  return res.json({
    prompt: row?.value || '',
    systemPromptEnabled: Boolean((row?.value || '').trim()),
    platformPrompts,
    platformPromptMeta,
  });
});

// PUT /api/copies/prompt
router.put('/prompt', (req: Request, res: Response) => {
  const { prompt } = req.body;
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('system_prompt', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(prompt || '');
  return res.json({ success: true });
});

// GET /api/copies/summary — copy counts per item (for filtering)
router.get('/summary/all', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare(
       `SELECT item, COUNT(*) as count,
        COUNT(DISTINCT CASE WHEN platform = 'post-helper' THEN '8891' ELSE platform END) as platforms
        FROM car_copies GROUP BY item`
     ).all() as any[];
    const summary: Record<string, { count: number; platforms: number }> = {};
    for (const row of rows) {
      summary[row.item] = { count: row.count, platforms: row.platforms };
    }
    return res.json(summary);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/copies/validation/8891-blockers
router.get('/validation/8891-blockers', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare(`
      SELECT cc.item, cc.platform, cc.validation_error_count, cc.validation_warning_count, cc.created_at,
             c.brand, c.model, c.year
      FROM car_copies cc
      JOIN cars c ON c.item = cc.item
      JOIN (
        SELECT item, MAX(created_at) AS latest_created_at
        FROM car_copies
        WHERE platform = '8891'
        GROUP BY item
      ) latest ON latest.item = cc.item AND latest.latest_created_at = cc.created_at
      WHERE cc.platform = '8891' AND cc.validation_status = 'error'
      ORDER BY cc.created_at DESC
    `).all() as any[];

    return res.json({
      items: rows.map(row => ({
        item: row.item,
        platform: row.platform,
        brand: row.brand,
        model: row.model,
        year: row.year,
        validationErrorCount: row.validation_error_count,
        validationWarningCount: row.validation_warning_count,
        createdAt: row.created_at,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// Parameterized routes LAST (catch-all patterns)
// ══════════════════════════════════════════════════════

// GET /api/copies/:item
router.get('/:item', (req: Request, res: Response) => {
  try {
    const copies = getCopies(req.params.item);
    return res.json({ copies, item: req.params.item });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/copies/:item/generate
router.post('/:item/generate', async (req: Request, res: Response) => {
  try {
    const { platform } = req.body;
    const cars = await getCars();
    const car = cars.find(c => c.item === req.params.item);
    if (!car) return res.status(404).json({ error: `Car ${req.params.item} not found` });

    if (hasActiveGeneration(req.params.item)) {
      return res.status(409).json({ error: `Car ${req.params.item} copy generation is already in progress` });
    }

    if (platform && PLATFORMS.includes(platform)) {
      const lockKey = getGenerationLockKey(req.params.item, platform);
      activeGenerationLocks.add(lockKey);
      try {
        const generated = await generateCopyWithMeta(car, platform);
        const copies = getCopies(req.params.item);
        return res.json({
          content: generated.content,
          copies,
          platform,
          reviewHints: generated.reviewHints,
          activeSkills: generated.activeSkills,
          generationContext: generated.generationContext,
        });
      } finally {
        activeGenerationLocks.delete(lockKey);
      }
    } else {
      const lockKey = getGenerationLockKey(req.params.item, '全部');
      activeGenerationLocks.add(lockKey);
      try {
        const generated = await generateAllCopies(car);
        const copies = getCopies(req.params.item);
        return res.json({
          results: generated.results,
          errors: generated.errors,
          copies,
          hasErrors: Object.keys(generated.errors).length > 0,
        });
      } finally {
        activeGenerationLocks.delete(lockKey);
      }
    }
  } catch (err: any) {
    console.error('[copies] Generate error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/copies/:id/publish
router.patch('/:id/publish', async (req: Request, res: Response) => {
  try {
    const copyId = Number(req.params.id);
    const copy = getCopyById(copyId);
    if (!copy) return res.status(404).json({ error: 'copy not found' });

    if (copy.platform === '8891' && copy.validation_status === 'error') {
      return res.status(400).json({ error: '8891 文案仍有阻塞問題，不能上架' });
    }

    const poPlatform = toPoPlatform(copy.platform);
    if (!poPlatform) return res.status(400).json({ error: 'unsupported copy platform' });

    const success = await setPoPlatform(copy.item, poPlatform, true);
    if (!success) return res.status(500).json({ error: '同步 PO 平台失敗' });

    publishCopy(copyId);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/copies/:id/unpublish
router.patch('/:id/unpublish', async (req: Request, res: Response) => {
  try {
    const copyId = Number(req.params.id);
    const copy = getCopyById(copyId);
    if (!copy) return res.status(404).json({ error: 'copy not found' });
    if (copy.status !== '上架') return res.status(400).json({ error: 'copy is not currently published' });

    const poPlatform = toPoPlatform(copy.platform);
    if (!poPlatform) return res.status(400).json({ error: 'unsupported copy platform' });

    const success = await setPoPlatform(copy.item, poPlatform, false);
    if (!success) return res.status(500).json({ error: '同步 PO 平台失敗' });

    unpublishCopy(copyId);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/copies/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const copyId = Number(req.params.id);
    const copy = getCopyById(copyId);
    if (!copy) return res.status(404).json({ error: 'copy not found' });

    if (copy.status === '上架') {
      const poPlatform = toPoPlatform(copy.platform);
      if (!poPlatform) return res.status(400).json({ error: 'unsupported copy platform' });

      const success = await setPoPlatform(copy.item, poPlatform, false);
      if (!success) return res.status(500).json({ error: '同步 PO 平台失敗' });
    }

    deleteCopy(copyId);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
