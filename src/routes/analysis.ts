import { Router, Request, Response } from 'express';
import { getCars } from '../services/carInventory';
import { analyzeVehiclePhotos, applyReviewDecision, getLatestPhotoAnalysis, getPendingVehicleAnalyses, getVehicleAnalysis, runBaselineAnalysis } from '../services/vehicleAnalysis';

const router = Router();

router.get('/pending', (_req: Request, res: Response) => {
  try {
    return res.json({ items: getPendingVehicleAnalyses() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:item', (req: Request, res: Response) => {
  try {
    const analysis = getVehicleAnalysis(req.params.item);
    if (!analysis) return res.status(404).json({ error: 'analysis not found' });
    return res.json({ ...analysis, photoAnalysis: getLatestPhotoAnalysis(req.params.item) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:item/run-baseline', async (req: Request, res: Response) => {
  try {
    const cars = await getCars();
    const car = cars.find(entry => entry.item === req.params.item);
    if (!car) return res.status(404).json({ error: 'car not found' });

    const analysis = await runBaselineAnalysis(car);
    return res.json({ ...analysis, photoAnalysis: getLatestPhotoAnalysis(req.params.item) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:item/photos', async (req: Request, res: Response) => {
  try {
    const uploads = Array.isArray(req.body?.photos) ? req.body.photos : [];
    const cars = await getCars();
    const car = cars.find(entry => entry.item === req.params.item);
    if (!car) return res.status(404).json({ error: 'car not found' });

    const photoAnalysis = await analyzeVehiclePhotos(car, uploads);
    return res.json({ photoAnalysis });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:item/review', async (req: Request, res: Response) => {
  try {
    const { source, field, reason, decision, value } = req.body || {};
    if (!source || !field || !reason || !decision) {
      return res.status(400).json({ error: 'source, field, reason, decision are required' });
    }

    if (source !== 'baseline' && source !== 'photo') {
      return res.status(400).json({ error: 'source must be baseline or photo' });
    }

    if (decision !== 'accept' && decision !== 'ignore') {
      return res.status(400).json({ error: 'decision must be accept or ignore' });
    }

    const result = applyReviewDecision(req.params.item, source, field, reason, decision, String(value || ''));
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
