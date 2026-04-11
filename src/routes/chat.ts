import { Router, Request, Response } from 'express';
import { processChat, getChatHistory, clearChatHistory } from '../services/agent';
import crypto from 'crypto';

const router = Router();

// POST /api/chat — send message, get SSE streaming response
router.post('/', (req: Request, res: Response) => {
  const { message, sessionId } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  const sid = sessionId || crypto.randomUUID();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Session-Id', sid);
  res.flushHeaders();

  processChat(
    sid,
    message.trim(),
    (text) => {
      res.write(`data: ${JSON.stringify({ text, sessionId: sid })}\n\n`);
    },
    () => {
      res.write(`data: ${JSON.stringify({ done: true, sessionId: sid })}\n\n`);
      res.end();
    },
    (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message, sessionId: sid })}\n\n`);
      res.end();
    }
  );
});

// GET /api/chat/history/:sessionId
router.get('/history/:sessionId', (req: Request, res: Response) => {
  const history = getChatHistory(req.params.sessionId);
  return res.json({ history, sessionId: req.params.sessionId });
});

// DELETE /api/chat/history/:sessionId
router.delete('/history/:sessionId', (req: Request, res: Response) => {
  clearChatHistory(req.params.sessionId);
  return res.json({ success: true });
});

export default router;
