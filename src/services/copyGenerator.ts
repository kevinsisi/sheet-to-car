import { GoogleGenerativeAI } from '@google/generative-ai';
import { withGeminiRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { CarRecord } from '../lib/sheets/types';
import db from '../db/connection';
import { loadPlatformPrompt } from '../prompts/promptLoader';
import { LoadedSkill, selectSkillsFor8891 } from './skillLoader';
import { getConfirmedVehicleContext } from './vehicleAnalysis';
import { getVinDecodeForCar, VinDecodeRecord } from './vinDecode';

const PLATFORMS = ['官網', 'Facebook', '8891'] as const;
export type Platform = typeof PLATFORMS[number];

interface TeamMember {
  name: string;
  english_name: string;
  phone: string;
  line_id: string;
  line_url: string;
}

export interface CopyReviewHint {
  field: string;
  reason: string;
  severity: 'info' | 'warning';
  suggestedValue?: string | number | null;
}

export interface GeneratedCopyResult {
  content: string;
  reviewHints: CopyReviewHint[];
  activeSkills: string[];
  generationContext: {
    confirmedFeatureCount: number;
    pendingFieldCount: number;
  };
}

function getTeamMembers(): TeamMember[] {
  return db.prepare('SELECT name, english_name, phone, line_id, line_url FROM team_members WHERE is_active = 1').all() as TeamMember[];
}

function findMemberByOwner(owner: string): TeamMember | null {
  const members = getTeamMembers();
  if (!owner) return members[0] || null;
  return members.find(m =>
    isOwnerMatched(owner, m)
  ) || members[0] || null;
}

function isOwnerMatched(owner: string, member: TeamMember): boolean {
  return member.english_name === owner
    || member.name.includes(owner)
    || owner.includes(member.english_name)
    || owner.includes(member.name);
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

function buildSkillBlock(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';

  return skills.map(skill => {
    return `## Active Skill: ${skill.name}\n${skill.content}`;
  }).join('\n\n');
}

function getPlatformSkills(platform: Platform): LoadedSkill[] {
  if (platform === '8891') {
    return selectSkillsFor8891();
  }

  return [];
}

function parseGeneratedJson(content: string): any | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function build8891ReviewHints(car: CarRecord, member: TeamMember, content: string): CopyReviewHint[] {
  const generated = parseGeneratedJson(content);
  if (!generated) {
    return [{
      field: 'json',
      reason: '8891 內容不是合法 JSON，需人工確認或重新生成。',
      severity: 'warning',
    }];
  }

  const hints: CopyReviewHint[] = [];
  const inferredFields = [
    'specs.engineDisplacement',
    'specs.transmission',
    'specs.fuelType',
    'specs.bodyType',
    'specs.doors',
    'specs.seats',
    'specs.drivetrain',
    'specs.horsepower',
    'specs.torque',
  ];

  for (const field of inferredFields) {
    const [section, key] = field.split('.');
    const value = generated?.[section]?.[key];
    if (value === null || value === undefined || value === '') {
      hints.push({
        field,
        reason: '此欄位缺少可直接驗證的表格來源，建議人工補確認。',
        severity: 'warning',
        suggestedValue: null,
      });
      continue;
    }

    hints.push({
      field,
      reason: '此欄位目前主要依品牌/車型規則推測，建議人工確認。',
      severity: 'info',
      suggestedValue: value,
    });
  }

  if (!car.owner || !member || !isOwnerMatched(car.owner, member)) {
    hints.push({
      field: 'contact',
      reason: '業務聯絡人是依 owner 模糊比對取得，建議人工確認。',
      severity: 'warning',
      suggestedValue: member?.name || null,
    });
  }

  return hints;
}

function buildVinDecodeBlock(vinDecode: VinDecodeRecord | null): string {
  if (!vinDecode) return '';

  return `\n\n## VIN Decode（外部依據，優先用於規格判斷）
- 品牌: ${vinDecode.make || '未提供'}
- 車型: ${vinDecode.model || '未提供'}
- 年份: ${vinDecode.year || '未提供'}
- 汽缸數: ${vinDecode.engineCylinders || '未提供'}
- 排氣量(L): ${vinDecode.engineDisplacementL || '未提供'}
- 引擎型號: ${vinDecode.engineModel || '未提供'}
- 燃料: ${vinDecode.fuelType || '未提供'}
- 馬力: ${vinDecode.horsepower || '未提供'}
- 驅動: ${vinDecode.driveType || '未提供'}
- 車身型式: ${vinDecode.bodyClass || '未提供'}
- 門數: ${vinDecode.doors || '未提供'}
- 變速箱: ${vinDecode.transmissionStyle || '未提供'}`;
}

async function buildPrompt(car: CarRecord, platform: Platform, member: TeamMember, prefs: Record<string, string>): Promise<string> {
  const customPrompt = getCustomPrompt();
  const contactBlock = buildContactBlock(member);
  const skills = getPlatformSkills(platform);
  const vehicleContext = getConfirmedVehicleContext(car.item);
  const vinDecode = await getVinDecodeForCar(car, true);

  let prompt = loadPlatformPrompt(platform);

  const skillBlock = buildSkillBlock(skills);
  if (skillBlock) {
    prompt += `\n\n${skillBlock}`;
  }

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

  if (vehicleContext.confirmedHighlights.length > 0 || vehicleContext.confirmedPhotoFindings.length > 0) {
    prompt += `\n\n## 已確認特徵（優先採用，不要再弱化成猜測）`;

    for (const finding of vehicleContext.confirmedHighlights) {
      prompt += `\n- ${finding}`;
    }

    for (const finding of vehicleContext.confirmedPhotoFindings) {
      prompt += `\n- ${finding}`;
    }
  }

  if (vehicleContext.pendingReviewFields.length > 0) {
    prompt += `\n\n## 尚未確認欄位（不可寫成已確認事實）\n- ${vehicleContext.pendingReviewFields.join('、')}`;
  }

  prompt += buildVinDecodeBlock(vinDecode);

  prompt += `\n\n請根據以上資料，生成${platform}平台的完整文案。直接輸出文案，不要加額外說明。`;

  return prompt;
}

/** Generate copy for a single platform */
export async function generateCopyWithMeta(car: CarRecord, platform: Platform): Promise<GeneratedCopyResult> {
  const member = findMemberByOwner(car.owner);
  if (!member) throw new Error('No team member available');
  const prefs = getUserPreferences();
  const skills = getPlatformSkills(platform);
  const vehicleContext = getConfirmedVehicleContext(car.item);

  const prompt = await buildPrompt(car, platform, member, prefs);

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

  const generationContext = {
    confirmedFeatureCount: vehicleContext.confirmedHighlights.length + vehicleContext.confirmedPhotoFindings.length,
    pendingFieldCount: vehicleContext.pendingReviewFields.length,
  };

  // Save to DB
  db.prepare(`
    INSERT INTO car_copies (item, platform, content, status, confirmed_feature_count, pending_field_count)
    VALUES (?, ?, ?, 'draft', ?, ?)
  `).run(car.item, platform, result, generationContext.confirmedFeatureCount, generationContext.pendingFieldCount);

  return {
    content: result,
    reviewHints: platform === '8891' ? build8891ReviewHints(car, member, result) : [],
    activeSkills: skills.map(skill => skill.name),
    generationContext,
  };
}

export async function generateCopy(car: CarRecord, platform: Platform): Promise<string> {
  return (await generateCopyWithMeta(car, platform)).content;
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
  confirmed_feature_count: number; pending_field_count: number;
}> {
  return db.prepare(
    'SELECT id, platform, content, status, created_at, expires_at, confirmed_feature_count, pending_field_count FROM car_copies WHERE item = ? ORDER BY created_at DESC'
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
