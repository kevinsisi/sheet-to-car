import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import db from '../db/connection';
import {
  getKeyList, addApiKey, removeApiKey, getUsageStats,
  getGeminiModel, invalidateKeyCache,
} from '../services/geminiKeys';
import { getAuthStatus } from '../lib/sheets/auth';
import { getKeyCount } from '../services/geminiKeys';

const router = Router();

const SENSITIVE_KEYS = ['gemini_api_key', 'gemini_api_keys'];

function maskValue(key: string, value: string): string {
  if (SENSITIVE_KEYS.includes(key) && value.length > 4) {
    return '*'.repeat(value.length - 4) + value.slice(-4);
  }
  return value;
}

// GET /api/settings
router.get('/', (_req: Request, res: Response) => {
  try {
    const settings = db.prepare('SELECT * FROM settings').all() as any[];
    const masked = settings.map(s => ({ ...s, value: maskValue(s.key, s.value) }));
    const auth = getAuthStatus();

    return res.json({
      settings: masked,
      sheetsAuth: auth,
      envKeys: { GEMINI_API_KEY: !!process.env.GEMINI_API_KEY },
      keyCount: getKeyCount(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings
router.put('/', (req: Request, res: Response) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, String(value));

    if (key === 'gemini_api_key' || key === 'gemini_api_keys' || key === 'gemini_model') {
      invalidateKeyCache();
    }

    return res.json({ key, value: maskValue(key, String(value)) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/api-keys
router.get('/api-keys', (_req: Request, res: Response) => {
  try {
    const keys = getKeyList();
    const model = getGeminiModel();
    return res.json({ keys, model });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/api-keys
router.post('/api-keys', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('AIza')) {
      return res.status(400).json({ error: 'Invalid API key format. Must start with AIza.' });
    }

    try {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({
        model: getGeminiModel(),
        generationConfig: { maxOutputTokens: 10 },
      });
      await model.generateContent('Say OK');
    } catch (testErr: any) {
      const msg = testErr?.message || '';
      if (msg.includes('401') || msg.includes('API_KEY_INVALID')) {
        return res.status(400).json({ error: 'API key is invalid.' });
      }
      if (msg.includes('403')) {
        return res.status(400).json({ error: 'API key lacks permission.' });
      }
      // 429 means valid but rate limited — allow it
      if (!msg.includes('429')) {
        return res.status(400).json({ error: `Validation failed: ${msg.slice(0, 100)}` });
      }
    }

    addApiKey(apiKey.trim());
    const keys = getKeyList();
    return res.status(201).json({ keys, added: apiKey.slice(-4) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/api-keys/batch
router.post('/api-keys/batch', (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing text field' });

    const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
    const added: string[] = [];
    for (const line of lines) {
      if (line.startsWith('-')) continue;
      if (line.startsWith('AIza') && line.length >= 30) {
        addApiKey(line);
        added.push('...' + line.slice(-4));
      }
    }
    const keys = getKeyList();
    return res.json({ keys, added, totalAdded: added.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/settings/api-keys/:suffix
router.delete('/api-keys/:suffix', (req: Request, res: Response) => {
  try {
    const removed = removeApiKey(req.params.suffix);
    if (!removed) return res.status(404).json({ error: 'Key not found' });
    const keys = getKeyList();
    return res.json({ keys, removed: req.params.suffix });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/validate-key
router.post('/validate-key', async (req: Request, res: Response) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ valid: false, error: 'Missing apiKey' });

  try {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: getGeminiModel(),
      generationConfig: { maxOutputTokens: 1 },
    });
    await model.generateContent('Hi');
    return res.json({ valid: true });
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('429')) return res.json({ valid: true, warning: 'Rate-limited but valid' });
    if (msg.includes('401') || msg.includes('API_KEY_INVALID')) return res.json({ valid: false, error: 'Invalid key' });
    if (msg.includes('403')) return res.json({ valid: false, error: 'No permission' });
    return res.json({ valid: false, error: msg.slice(0, 150) });
  }
});

// GET /api/settings/token-usage
router.get('/token-usage', (_req: Request, res: Response) => {
  try {
    return res.json(getUsageStats());
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
