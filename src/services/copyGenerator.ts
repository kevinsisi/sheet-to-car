import { GoogleGenerativeAI } from '@google/generative-ai';
import { withGeminiRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { CarRecord } from '../lib/sheets/types';
import db from '../db/connection';
import { loadPlatformPrompt } from '../prompts/promptLoader';

const PLATFORMS = ['官網', 'Facebook', 'post-helper'] as const;
export type Platform = typeof PLATFORMS[number];

interface TeamMember {
  name: string;
  english_name: string;
  phone: string;
  line_id: string;
  line_url: string;
}

function getTeamMembers(): TeamMember[] {
  return db.prepare('SELECT name, english_name, phone, line_id, line_url FROM team_members WHERE is_active = 1').all() as TeamMember[];
}

function findMemberByOwner(owner: string): TeamMember | null {
  const members = getTeamMembers();
  if (!owner) return members[0] || null;
  return members.find(m =>
    m.english_name === owner ||
    m.name.includes(owner) ||
    owner.includes(m.english_name) ||
    owner.includes(m.name)
  ) || members[0] || null;
}

function getUserPreferences(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM user_preferences').all() as any[];
  const prefs: Record<string, string> = {};
  for (const row of rows) prefs[row.key] = row.value;
  return prefs;
}

function getCustomPrompt(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'system_prompt'").get() as any;
  return row?.value || '';
}

function buildContactBlock(member: TeamMember): string {
  return `🔹若您有興趣，請聯繫銷售業務：
▪️手機：${member.phone} ${member.name}
▪️一鍵加Line：${member.line_url}
▪️Line ID：${member.line_id}

📍 遇見好車 CarsMeet
📞 總機：02-2794-9910`;
}

function buildPrompt(car: CarRecord, platform: Platform, member: TeamMember, prefs: Record<string, string>): string {
  const customPrompt = getCustomPrompt();
  const contactBlock = buildContactBlock(member);

  let prompt = loadPlatformPrompt(platform);

  if (customPrompt) {
    prompt += `\n\n## 額外指示\n${customPrompt}`;
  }

  if (prefs.tone) {
    prompt += `\n\n## 使用者偏好語氣\n${prefs.tone}`;
  }
  if (prefs.style) {
    prompt += `\n\n## 使用者偏好風格\n${prefs.style}`;
  }
  if (prefs.custom_rules) {
    prompt += `\n\n## 使用者自訂規則\n${prefs.custom_rules}`;
  }

  prompt += `\n\n## 業務聯絡（固定放在結尾）\n${contactBlock}`;

  prompt += `\n\n## 車輛資料
- 編號: ${car.item}
- 品牌: ${car.brand}
- 年式: ${car.year}
- 車型: ${car.model}
- VIN: ${car.vin || '未提供'}
- 里程: ${car.mileage || '未提供'}
- 車況: ${car.condition || '未提供'}
- 外觀色: ${car.exteriorColor || '未提供'}
- 內裝色: ${car.interiorColor || '未提供'}
- 改裝/特殊選配: ${car.modification || '無'}
- 備註: ${car.note || '無'}`;

  prompt += `\n\n請根據以上資料，生成${platform}平台的完整文案。直接輸出文案，不要加額外說明。`;

  return prompt;
}

/** Generate copy for a single platform */
export async function generateCopy(car: CarRecord, platform: Platform): Promise<string> {
  const member = findMemberByOwner(car.owner);
  if (!member) throw new Error('No team member available');
  const prefs = getUserPreferences();

  const prompt = buildPrompt(car, platform, member, prefs);

  const result = await withGeminiRetry(async (apiKey) => {
    const genai = new GoogleGenerativeAI(apiKey);
    const model = genai.getGenerativeModel({
      model: getGeminiModel(),
    });
    const resp = await model.generateContent(prompt);
    const text = resp.response.text();

    if (resp.response.usageMetadata) {
      trackUsage(apiKey, getGeminiModel(), 'copy-gen', resp.response.usageMetadata);
    }

    return text;
  });

  // Remove existing draft to prevent duplicates
  db.prepare(`
    DELETE FROM car_copies 
    WHERE item = ? AND platform = ? AND status = 'draft'
  `).run(car.item, platform);

  // Save to DB
  db.prepare(`
    INSERT INTO car_copies (item, platform, content, status)
    VALUES (?, ?, ?, 'draft')
  `).run(car.item, platform, result);

  return result;
}

/** Generate copies for all platforms */
export async function generateAllCopies(car: CarRecord): Promise<Record<Platform, string>> {
  // Clear all existing drafts for this car before regenerating all
  db.prepare(`
    DELETE FROM car_copies 
    WHERE item = ? AND status = 'draft'
  `).run(car.item);

  const results: Record<string, string> = {};
  for (const platform of PLATFORMS) {
    results[platform] = await generateCopy(car, platform);
  }
  return results as Record<Platform, string>;
}

/** Get existing copies for a car */
export function getCopies(item: string): Array<{
  id: number; platform: string; content: string; status: string;
  created_at: string; expires_at: string | null;
}> {
  return db.prepare(
    'SELECT id, platform, content, status, created_at, expires_at FROM car_copies WHERE item = ? ORDER BY created_at DESC'
  ).all(item) as any[];
}

/** Set copy status to 上架 with 7-day expiry */
export function publishCopy(copyId: number): void {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "UPDATE car_copies SET status = '上架', published_at = datetime('now'), expires_at = ? WHERE id = ?"
  ).run(expiresAt, copyId);
}

/** Set copy status back to draft */
export function unpublishCopy(copyId: number): void {
  db.prepare(
    "UPDATE car_copies SET status = 'draft', published_at = NULL, expires_at = NULL WHERE id = ?"
  ).run(copyId);
}

/** Delete a copy */
export function deleteCopy(copyId: number): void {
  db.prepare('DELETE FROM car_copies WHERE id = ?').run(copyId);
}

/** Clean up expired copies (call periodically) */
export function cleanExpiredCopies(): number {
  const result = db.prepare(
    "DELETE FROM car_copies WHERE status = '上架' AND expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).run();
  if (result.changes > 0) {
    console.log(`[copies] Cleaned ${result.changes} expired copies`);
  }
  return result.changes;
}

/** Save user preference */
export function setUserPreference(key: string, value: string): void {
  db.prepare(
    "INSERT INTO user_preferences (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  ).run(key, value);
}

/** Get all user preferences */
export function getAllPreferences(): Record<string, string> {
  return getUserPreferences();
}

export function getPlatformPrompts(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const p of PLATFORMS) {
    result[p] = loadPlatformPrompt(p);
  }
  return result;
}

export { PLATFORMS, getTeamMembers };
