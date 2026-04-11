import db from '../db/connection';

const DEFAULT_MODEL = 'gemini-2.5-flash';

let cachedKeys: string[] = [];
let lastLoadTime = 0;
const CACHE_TTL = 60_000;

function isValidKeyFormat(key: string): boolean {
  if (key.length < 20) return false;
  if (/^(your|placeholder|test|example|dummy|fake|xxx|change.?me)/i.test(key)) return false;
  return true;
}

function loadBlockedSuffixes(): Set<string> {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'blocked_api_keys'").get() as any;
  if (!row?.value) return new Set();
  return new Set(row.value.split(',').map((s: string) => s.trim()).filter(Boolean));
}

function loadKeys(): string[] {
  const now = Date.now();
  if (cachedKeys.length > 0 && now - lastLoadTime < CACHE_TTL) return cachedKeys;

  const blocked = loadBlockedSuffixes();
  const keys: string[] = [];

  if (process.env.GEMINI_API_KEY) {
    const envKeys = process.env.GEMINI_API_KEY.split(',')
      .map(k => k.trim())
      .filter(k => k && isValidKeyFormat(k) && !blocked.has(k.slice(-4)));
    keys.push(...envKeys);
  }

  const multi = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_keys'").get() as any;
  if (multi?.value) {
    keys.push(...multi.value.split(',').map((k: string) => k.trim()).filter(Boolean));
  }

  const single = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get() as any;
  if (single?.value) {
    keys.push(single.value.trim());
  }

  const seen = new Set<string>();
  cachedKeys = keys.filter(k => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  lastLoadTime = now;
  return cachedKeys;
}

export function invalidateKeyCache(): void {
  lastLoadTime = 0;
  cachedKeys = [];
}

const COOLDOWN_MS: Record<string, number> = {
  '429': 120_000,
  '401': 1_800_000,
  '403': 1_800_000,
  'server_error': 30_000,
};

const badKeys = new Map<string, number>();
let cooldownsLoaded = false;

function loadCooldownsFromDb(): void {
  if (cooldownsLoaded) return;
  try {
    const rows = db.prepare('SELECT api_key_suffix, cooldown_until FROM api_key_cooldowns').all() as any[];
    const now = Date.now();
    for (const row of rows) {
      if (row.cooldown_until > now) {
        const keys = loadKeys();
        const fullKey = keys.find(k => k.slice(-4) === row.api_key_suffix);
        if (fullKey) badKeys.set(fullKey, row.cooldown_until);
      }
    }
    db.prepare('DELETE FROM api_key_cooldowns WHERE cooldown_until < ?').run(now);
  } catch {}
  cooldownsLoaded = true;
}

export function markKeyBad(key: string, reason: string = '429'): void {
  const cooldownMs = COOLDOWN_MS[reason] || COOLDOWN_MS['429'];
  const cooldownUntil = Date.now() + cooldownMs;
  badKeys.set(key, cooldownUntil);
  const suffix = key.slice(-4);
  console.warn(`[keys] Marked bad: ...${suffix} (${reason}, cooldown ${cooldownMs / 1000}s)`);
  try {
    db.prepare(
      `INSERT INTO api_key_cooldowns (api_key_suffix, cooldown_until, reason) VALUES (?, ?, ?)
       ON CONFLICT(api_key_suffix) DO UPDATE SET cooldown_until = excluded.cooldown_until, reason = excluded.reason`
    ).run(suffix, cooldownUntil, reason);
  } catch {}
}

export function blockApiKey(key: string): void {
  const suffix = key.slice(-4);
  const blocked = loadBlockedSuffixes();
  blocked.add(suffix);
  badKeys.delete(key);

  try {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('blocked_api_keys', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ).run([...blocked].join(','));
    db.prepare('DELETE FROM api_key_cooldowns WHERE api_key_suffix = ?').run(suffix);
  } catch {}

  invalidateKeyCache();
  console.warn(`[keys] Blocked permanently: ...${suffix}`);
}

function getAvailableKeys(): string[] {
  loadCooldownsFromDb();
  const now = Date.now();
  const keys = loadKeys();
  for (const [k, until] of badKeys) {
    if (now >= until) badKeys.delete(k);
  }
  const available = keys.filter(k => !badKeys.has(k));
  if (available.length > 0) return available;

  let oldestKey = '';
  let oldestUntil = Infinity;
  for (const [k, until] of badKeys) {
    if (until < oldestUntil) { oldestUntil = until; oldestKey = k; }
  }
  if (oldestKey) {
    badKeys.delete(oldestKey);
    try { db.prepare('DELETE FROM api_key_cooldowns WHERE api_key_suffix = ?').run(oldestKey.slice(-4)); } catch {}
    console.warn(`[keys] All keys on cooldown — force-cleared oldest: ...${oldestKey.slice(-4)}`);
  }
  return keys;
}

export function assignBatchKeys(count: number): string[] {
  const available = [...getAvailableKeys()];
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, count);
}

export function getGeminiApiKey(): string | null {
  const keys = getAvailableKeys();
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}

export function getGeminiApiKeyExcluding(failedKey: string): string | null {
  markKeyBad(failedKey);
  const keys = getAvailableKeys().filter(k => k !== failedKey);
  if (keys.length === 0) return null;
  return keys[Math.floor(Math.random() * keys.length)];
}

export function getGeminiModel(): string {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'gemini_model'").get() as any;
  return setting?.value || DEFAULT_MODEL;
}

export function getKeyCount(): number {
  return loadKeys().length;
}

export function trackUsage(
  apiKey: string, model: string, callType: string, usageMetadata: any, projectId?: string
): void {
  try {
    const suffix = apiKey.slice(-4);
    const prompt = usageMetadata?.promptTokenCount || 0;
    const completion = usageMetadata?.candidatesTokenCount || 0;
    const total = usageMetadata?.totalTokenCount || 0;
    db.prepare(
      'INSERT INTO api_key_usage (api_key_suffix, model, call_type, prompt_tokens, completion_tokens, total_tokens, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(suffix, model, callType, prompt, completion, total, projectId || null);
  } catch {}
}

export function getKeyList(): Array<{
  suffix: string; todayCalls: number; todayTokens: number;
  totalCalls: number; totalTokens: number; fromEnv: boolean;
}> {
  const keys = loadKeys();
  const envKeys = new Set(
    (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean)
  );
  return keys.map(k => {
    const suffix = k.slice(-4);
    const today = db.prepare(
      `SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens
       FROM api_key_usage WHERE api_key_suffix = ? AND date(created_at) = date('now')`
    ).get(suffix) as any;
    const total = db.prepare(
      `SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens
       FROM api_key_usage WHERE api_key_suffix = ?`
    ).get(suffix) as any;
    return {
      suffix,
      todayCalls: today?.calls || 0,
      todayTokens: today?.tokens || 0,
      totalCalls: total?.calls || 0,
      totalTokens: total?.tokens || 0,
      fromEnv: envKeys.has(k),
    };
  });
}

export function addApiKey(newKey: string): void {
  const keys = loadKeys();
  if (keys.includes(newKey)) return;
  keys.push(newKey);
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('gemini_api_keys', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(keys.join(','));
  invalidateKeyCache();
}

export function removeApiKey(suffix: string): boolean {
  const keys = loadKeys();
  const target = keys.find(k => k.slice(-4) === suffix);
  if (!target) return false;

  const envKeys = new Set(
    (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean)
  );
  if (envKeys.has(target)) {
    const blocked = loadBlockedSuffixes();
    blocked.add(suffix);
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('blocked_api_keys', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ).run([...blocked].join(','));
  } else {
    const filtered = keys.filter(k => k.slice(-4) !== suffix);
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('gemini_api_keys', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ).run(filtered.join(','));
  }

  invalidateKeyCache();
  return true;
}

export function getUsageStats(): {
  today: { calls: number; tokens: number };
  week: { calls: number; tokens: number };
  month: { calls: number; tokens: number };
} {
  const today = db.prepare(
    `SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens
     FROM api_key_usage WHERE date(created_at) = date('now')`
  ).get() as any;
  const week = db.prepare(
    `SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens
     FROM api_key_usage WHERE created_at >= datetime('now', '-7 days')`
  ).get() as any;
  const month = db.prepare(
    `SELECT COUNT(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens
     FROM api_key_usage WHERE created_at >= datetime('now', '-30 days')`
  ).get() as any;
  return {
    today: { calls: today?.calls || 0, tokens: today?.tokens || 0 },
    week: { calls: week?.calls || 0, tokens: week?.tokens || 0 },
    month: { calls: month?.calls || 0, tokens: month?.tokens || 0 },
  };
}
