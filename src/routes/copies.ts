import { Router, Request, Response } from 'express';
import { getCars } from '../services/carInventory';
import {
  generateCopy, generateAllCopies, getCopies,
  publishCopy, unpublishCopy, deleteCopy, cleanExpiredCopies,
  setUserPreference, getAllPreferences, getTeamMembers, PLATFORMS,
} from '../services/copyGenerator';
import db from '../db/connection';

const router = Router();

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
  return res.json({ prompt: row?.value || '' });
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
