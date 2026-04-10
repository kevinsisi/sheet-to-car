import express from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import { runMigrations } from './db/migrate';
import apiRouter from './routes/api';
import chatRouter from './routes/chat';
import settingsRouter from './routes/settings';
import copiesRouter from './routes/copies';
import promptsRouter from './routes/prompts';
import analysisRouter from './routes/analysis';
import { cleanExpiredCopies } from './services/copyGenerator';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Run DB migrations
runMigrations();

// API routes
app.use('/api', apiRouter);
app.use('/api/chat', chatRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/copies', copiesRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/analysis', analysisRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sheet-to-Car running on http://localhost:${PORT}`);
  // Clean expired copies every hour
  setInterval(() => cleanExpiredCopies(), 60 * 60 * 1000);
  cleanExpiredCopies();
});
