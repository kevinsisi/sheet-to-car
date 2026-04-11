import { Router, Request, Response } from 'express';
import { PLATFORMS } from '../services/copyGenerator';
import {
  loadPlatformPrompt,
  savePlatformPrompt,
  resetPlatformPrompt,
  getBuiltinPrompt,
} from '../prompts/promptLoader';

const router = Router();

const VALID_PLATFORMS = new Set<string>(PLATFORMS);

// GET /api/prompts/:platform
router.get('/:platform', (req: Request, res: Response) => {
  const { platform } = req.params;
  if (!VALID_PLATFORMS.has(platform)) {
    return res.status(400).json({ error: `Unknown platform: ${platform}` });
  }
  const content = loadPlatformPrompt(platform);
  const builtin = getBuiltinPrompt(platform);
  const isCustomized = content !== builtin;
  return res.json({
    platform,
    content,
    isCustomized,
    source: isCustomized ? 'user-override' : 'builtin',
  });
});

// PUT /api/prompts/:platform
router.put('/:platform', (req: Request, res: Response) => {
  const { platform } = req.params;
  if (!VALID_PLATFORMS.has(platform)) {
    return res.status(400).json({ error: `Unknown platform: ${platform}` });
  }
  const { content } = req.body;
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  savePlatformPrompt(platform, content);
  return res.json({ success: true, platform });
});

// POST /api/prompts/:platform/reset
router.post('/:platform/reset', (req: Request, res: Response) => {
  const { platform } = req.params;
  if (!VALID_PLATFORMS.has(platform)) {
    return res.status(400).json({ error: `Unknown platform: ${platform}` });
  }
  resetPlatformPrompt(platform);
  const content = loadPlatformPrompt(platform);
  return res.json({ success: true, platform, content });
});

export default router;
