import { Router, Request, Response } from 'express';
import { getCars, getNewCars, getStats, setPoStatus, syncFromSheet } from '../services/carInventory';

const router = Router();

// GET /api/cars — list all cars with optional filters
router.get('/cars', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';
    let cars = await getCars(refresh);

    const { status, brand, source, poStatus, search } = req.query;
    if (status) cars = cars.filter(c => c.status === status);
    if (brand) cars = cars.filter(c => c.brand === brand);
    if (source) cars = cars.filter(c => c.source === source);
    if (poStatus) cars = cars.filter(c => c.poStatus === poStatus);
    if (search) {
      const q = (search as string).toLowerCase();
      cars = cars.filter(c =>
        c.item.toLowerCase().includes(q) ||
        c.brand.toLowerCase().includes(q) ||
        c.model.toLowerCase().includes(q) ||
        c.vin.toLowerCase().includes(q)
      );
    }

    return res.json({ cars, total: cars.length });
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
    const stats = await getStats();
    return res.json(stats);
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
