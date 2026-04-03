import { GoogleGenerativeAI } from '@google/generative-ai';
import { withGeminiRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { CarRecord } from '../lib/sheets/types';
import db from '../db/connection';

const PLATFORMS = ['官網', '8891', 'Facebook', 'post-helper'] as const;
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

const PLATFORM_PROMPTS: Record<Platform, string> = {
  '官網': `你是「遇見好車 CarsMeet」的官方文案撰寫 AI。

## 風格規範
- 精品、高端、內斂、有格調
- 目標對象：50歲上下高資產男性，豪車收藏客群
- 情緒調性：精緻、沉穩、帶一點感性
- 字不多、節奏乾淨

## 禁止
- 不可出現「這不是⋯而是⋯」
- 不寫太商業、太熱血、太誇張的句子
- 不寫過度比喻

## 可使用的風格
- 氛圍式形容（光影、線條、比例、材質）
- 輕感性敘事（例如「值得等待」「剛好的張力」）
- 收藏價值、稀缺性、配色美學、選配亮點

## 文案格式
1. 標題區：✨全台最齊全✨ + #車款Hashtag + 連結
2. 主體：3~6行敘述，抓住配色、選配、氣場、駕馭感受
3. 若有改裝/特殊選配，必須著重描述
4. 結尾：保固段落 + 業務聯絡

## 固定段落
#一年保固 全台唯一不限額
最好的售後服務，讓您安心購車。`,

  '8891': `你是「遇見好車 CarsMeet」的 8891 中古車平台文案 AI。

## 平台特性
- 以結構化資訊為主，買家注重規格、配備、車況
- 文案簡潔有力、資訊明確

## 必填五大欄位
1. 引擎燃料（汽油/柴油/油電/純電）
2. 變速系統（自排/手排/DCT）
3. 驅動方式（後驅/四驅）
4. 排氣量（cc）
5. 引擎發動機（形式+馬力+扭力）

## 品牌規則
- Bentley 沒寫 W12 → 一律 V8
- Rolls-Royce 預設 V12（Ghost 除外為 V12 Twin-Turbo）

## 文案格式
1. 標題：年份 品牌 車型 + 2~3個亮點
2. 五大欄位
3. 重點選配清單（條列式）
4. 若有改裝，獨立列出改裝項目
5. 業務聯絡資訊`,

  'Facebook': `你是「遇見好車 CarsMeet」的 Facebook/IG 社群文案 AI。

## 風格
- 與官網共用精品高端風格
- 6~9 行為佳，留白乾淨、有呼吸感
- 以「成熟收藏客」喜歡的語氣撰寫

## 格式
1. 標題：✨全台最齊全✨ + #車款Hashtag + 連結
2. 主體：3~6行敘述
3. 若有改裝/特殊配備，重點描述
4. 固定保固段落
5. 業務聯絡資訊
6. 品牌 Hashtag（#藍寶堅尼 #勞斯萊斯 #賓利 等）

## Hashtag 對照
Rolls-Royce→#勞斯萊斯, Bentley→#賓利, Lamborghini→#藍寶堅尼, Ferrari→#法拉利, Porsche→#保時捷, McLaren→#麥拉倫, Aston Martin→#奧斯頓馬丁, Mercedes-Maybach→#邁巴赫`,

  'post-helper': `你是汽車資料 JSON 生成器，為 Post-Helper Chrome 插件產出可匯入的 JSON。

## 輸出格式
必須輸出合法 JSON（不要 markdown code block），結構如下：
{
  "basic": { "brand": "品牌英文", "model": "完整車型", "year": 數字, "mileage": 里程數字或null, "price": 0 },
  "specs": { "color": "外觀色", "interiorColor": "內裝色", "engineDisplacement": cc數, "transmission": "automatic/manual/dct", "fuelType": "gasoline/diesel/hybrid/electric", "bodyType": "sedan/suv/coupe/convertible", "doors": 門數, "seats": 座位數, "drivetrain": "AWD/2WD", "horsepower": 馬力, "torque": 扭力Nm },
  "contact": { "name": "業務姓名", "mobile": "手機", "phone": "02-2794-9910", "lineId": "line_id", "location": { "city": "台北市", "district": "內湖區", "address": "行忠路57號" } },
  "listing": { "title": "刊登標題", "description": "重點選配條列", "highlightFeatures": ["特色1","特色2"] }
}

## 規格推斷規則
- Bentley 沒寫 W12 → V8 (3996cc, 550hp, 770Nm)
- Rolls-Royce → V12 (6749cc, 563hp, 850Nm)
- Lamborghini Urus → V8 Twin-Turbo (3996cc, 641hp, 850Nm)
- Ferrari F8 → V8 Twin-Turbo (3902cc, 720hp, 770Nm)
- GT/Coupe → bodyType: "coupe", doors: 2
- SUV/Urus/Cullinan → bodyType: "suv", doors: 5
- Sedan/Ghost/Flying Spur → bodyType: "sedan", doors: 4

## 變速箱
Bentley/RR/Benz → "automatic", Lamborghini/Ferrari/Porsche → "dct"

## 注意
- price 設 0（使用者自填）
- mileage 用公里數字，無資料設 null
- 盡可能填寫所有欄位，避免 null
- 只輸出 JSON，不要其他文字`,
};

function buildPrompt(car: CarRecord, platform: Platform, member: TeamMember, prefs: Record<string, string>): string {
  const customPrompt = getCustomPrompt();
  const contactBlock = buildContactBlock(member);

  let prompt = PLATFORM_PROMPTS[platform];

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

  // Save to DB
  db.prepare(`
    INSERT INTO car_copies (item, platform, content, status)
    VALUES (?, ?, ?, 'draft')
  `).run(car.item, platform, result);

  return result;
}

/** Generate copies for all platforms */
export async function generateAllCopies(car: CarRecord): Promise<Record<Platform, string>> {
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
  return { ...PLATFORM_PROMPTS };
}

export { PLATFORMS, getTeamMembers };
