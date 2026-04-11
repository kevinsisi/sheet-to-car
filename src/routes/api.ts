import { Router, Request, Response } from 'express';
import { clearOwnerOverride, getCarsPaginated, syncCarsToDb, getNewCars, getStats, setOwnerOverride, setPoStatus, setPoPlatform, syncFromSheet, getAllCars } from '../services/carInventory';
import db from '../db/connection';

const router = Router();

// GET /api/cars — paginated cars with server-side filtering
router.get('/cars', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';
    const all = req.query.all === 'true';

    // Sync if refresh requested or on first load
    await syncCarsToDb(refresh);

    if (all) {
      const cars = getAllCars();
      return res.json({ cars, total: cars.length });
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize as string) || 50));
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const poStatus = req.query.poStatus as string | undefined;
    const copyStatus = req.query.copyStatus as string | undefined;
    const sort = req.query.sort as string || 'item';
    const order = (req.query.order as string || 'desc') as 'asc' | 'desc';

    const result = getCarsPaginated({ page, pageSize, search, status, poStatus, copyStatus, sort, order });
    return res.json(result);
  } catch (err: any) {
    console.error('[api] Error fetching cars:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/cars/new — new arrivals
router.get('/cars/new', async (_req: Request, res: Response) => {
  try {
    const cars = await getNewCars();
    return res.json({ cars, total: cars.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/cars/stats — aggregate stats
router.get('/cars/stats', async (_req: Request, res: Response) => {
  try {
    await syncCarsToDb();
    const stats = getStats();
    return res.json(stats);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/cars/:item/po-platform — update per-platform PO status
router.post('/cars/:item/po-platform', async (req: Request, res: Response) => {
  try {
    const { item } = req.params;
    const { platform, value } = req.body;
    if (!platform || value === undefined) {
      return res.status(400).json({ error: 'platform and value are required' });
    }

    const success = await setPoPlatform(item, platform, !!value);
    if (!success) return res.status(404).json({ error: `Car "${item}" not found or invalid platform` });

    return res.json({ success: true, item, platform, value: !!value });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/cars/:item/po — update PO status
router.post('/cars/:item/po', async (req: Request, res: Response) => {
  try {
    const { item } = req.params;
    const { poStatus } = req.body;
    if (!poStatus) return res.status(400).json({ error: 'poStatus is required' });

    const success = await setPoStatus(item, poStatus);
    if (!success) return res.status(404).json({ error: `Car "${item}" not found in sheet` });

    return res.json({ success: true, item, poStatus });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/cars/:item/owner — set local owner override
router.patch('/cars/:item/owner', async (req: Request, res: Response) => {
  try {
    const { item } = req.params;
    const owner = String(req.body?.owner || '').trim();
    if (!owner) {
      return res.status(400).json({ error: 'owner is required' });
    }

    const validOwner = db.prepare('SELECT 1 FROM team_members WHERE is_active = 1 AND english_name = ?').get(owner) as any;
    if (!validOwner) {
      return res.status(400).json({ error: 'owner must be an active team member english_name' });
    }

    const success = setOwnerOverride(item, owner);
    if (!success) return res.status(404).json({ error: `Car "${item}" not found` });

    return res.json({ success: true, item, owner });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/cars/:item/owner — clear local owner override
router.delete('/cars/:item/owner', async (req: Request, res: Response) => {
  try {
    const { item } = req.params;
    const success = clearOwnerOverride(item);
    if (!success) return res.status(404).json({ error: `No owner override found for car "${item}"` });
    return res.json({ success: true, item });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/sync — force refresh from Google Sheets
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const count = await syncFromSheet();
    return res.json({ success: true, count });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
