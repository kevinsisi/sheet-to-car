import db from './connection';
import fs from 'fs';
import path from 'path';

export function runMigrations(): void {
  const migrationsDir = path.resolve(__dirname, './migrations');

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all()
      .map((row: any) => row.filename)
  );

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    console.log(`Running migration: ${file}`);

    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);

    console.log(`Migration applied: ${file}`);
  }
}
