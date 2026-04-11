import { GoogleGenerativeAI } from '@google/generative-ai';
import { withGeminiRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { CarRecord } from '../lib/sheets/types';
import db from '../db/connection';
import { loadPlatformPrompt } from '../prompts/promptLoader';
import { LoadedSkill, selectSkillsFor8891 } from './skillLoader';
import { getConfirmedVehicleContext, getConfirmedVehicleFieldMap } from './vehicleAnalysis';
import { getVinDecodeForCar, VinDecodeRecord } from './vinDecode';

const PLATFORMS = ['官網', 'Facebook', '8891'] as const;
export type Platform = typeof PLATFORMS[number];

interface TeamMember {
  name: string;
  english_name: string;
  phone: string;
  line_id: string;
  line_url: string;
  aliases?: string;
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
  validationSummary?: {
    status: 'ready' | 'warning' | 'error';
    errorCount: number;
    warningCount: number;
  };
}

interface ValidationMessage {
  field: string;
  message: string;
  type: 'error' | 'warning';
}

interface GenerationInputs {
  member: TeamMember;
  prefs: Record<string, string>;
  vehicleContext: ReturnType<typeof getConfirmedVehicleContext>;
  vinDecode: VinDecodeRecord | null;
}

function getTeamMembers(): TeamMember[] {
  return db.prepare('SELECT name, english_name, phone, line_id, line_url, aliases FROM team_members WHERE is_active = 1').all() as TeamMember[];
}

function findMemberByOwner(owner: string): TeamMember | null {
  const members = getTeamMembers();
  const ownerTokens = tokenizeOwnerIdentifiers(owner);
  if (ownerTokens.length === 0) return null;

  const matches = members.filter(member => isOwnerMatched(owner, member));
  return matches.length === 1 ? matches[0] : null;
}

function isOwnerMatched(owner: string, member: TeamMember): boolean {
  const ownerTokens = tokenizeOwnerIdentifiers(owner);
  if (ownerTokens.length === 0) return false;

  const memberTokens = new Set([
    normalizeOwner(member.english_name),
    normalizeOwner(member.name),
    ...String(member.aliases || '')
      .split(',')
      .map(token => normalizeOwner(token))
      .filter(Boolean),
  ].filter(Boolean));

  return ownerTokens.some(token => memberTokens.has(token));
}

function normalizeOwner(owner: string): string {
  const raw = String(owner || '').trim();
  if (!raw) return '';

  return raw
    .replace(/^訂車/, '')
    .replace(/[（）()]/g, '')
    .replace(/[\s\-_/]+/g, '')
    .trim();
}

function tokenizeOwnerIdentifiers(owner: string): string[] {
  const raw = String(owner || '').trim();
  if (!raw) return [];

  const segments = raw
    .replace(/[()（）]/g, ' ')
    .split(/[\s,，/|]+/)
    .map(segment => normalizeOwner(segment))
    .filter(Boolean);

  const normalizedWhole = normalizeOwner(raw);
  if (normalizedWhole) segments.push(normalizedWhole);

  return [...new Set(segments)];
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

📍 遇見好車 CarsMeet`;
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
    return JSON.parse(stripMarkdownCodeFence(content));
  } catch {
    return null;
  }
}

function stripMarkdownCodeFence(content: string): string {
  const trimmed = String(content || '').trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function normalizeFreeText(input: string): string {
  return String(input || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function mergePhotoSuggestedLines(platform: Platform, content: string, vehicleContext: GenerationInputs['vehicleContext']): string {
  const lines = vehicleContext.photoSuggestedLines.filter(Boolean);
  if (lines.length === 0 || vehicleContext.photoReviewPending) return content;

  const normalizedContent = normalizeFreeText(content);
  const missingLines = lines.filter(line => !normalizedContent.includes(normalizeFreeText(line)));
  if (missingLines.length === 0) return content;

  const firstLine = missingLines[0].trim();
  if (!firstLine) return content;

  if (platform === '8891') {
    const parsed = parseGeneratedJson(content);
    if (!parsed || typeof parsed !== 'object') return content;
    if (!parsed.listing || typeof parsed.listing !== 'object' || Array.isArray(parsed.listing)) {
      parsed.listing = {};
    }
    const existing = String(parsed.listing.description || '').trim();
    parsed.listing.description = existing ? `${existing}\n${firstLine}` : firstLine;
    return JSON.stringify(parsed, null, 2);
  }

  return `${content}\n\n照片補充觀察：${firstLine}`;
}

function normalize8891Json(data: any): any {
  if (!data || typeof data !== 'object') return data;

  const normalized = JSON.parse(JSON.stringify(data));
  normalized.basic = normalized.basic || {};
  normalized.specs = normalized.specs || {};
  normalized.contact = normalized.contact || {};
  normalized.listing = normalized.listing || {};

  if (typeof normalized.basic.year === 'string') {
    normalized.basic.year = parseFirstInteger(normalized.basic.year) ?? normalized.basic.year;
  }
  if (typeof normalized.basic.mileage === 'string') {
    normalized.basic.mileage = parseMileage(normalized.basic.mileage);
  }
  if (typeof normalized.basic.price === 'string') {
    normalized.basic.price = parsePrice(normalized.basic.price);
  }
  if (typeof normalized.specs.engineDisplacement === 'string') {
    normalized.specs.engineDisplacement = parseFirstInteger(normalized.specs.engineDisplacement) ?? normalized.specs.engineDisplacement;
  }
  if (typeof normalized.specs.doors === 'string') {
    normalized.specs.doors = parseFirstInteger(normalized.specs.doors) ?? normalized.specs.doors;
  }
  if (typeof normalized.specs.seats === 'string') {
    normalized.specs.seats = parseFirstInteger(normalized.specs.seats) ?? normalized.specs.seats;
  }
  if (typeof normalized.specs.horsepower === 'string') {
    normalized.specs.horsepower = parseFirstInteger(normalized.specs.horsepower) ?? normalized.specs.horsepower;
  }
  if (typeof normalized.specs.torque === 'string') {
    normalized.specs.torque = parseFirstInteger(normalized.specs.torque) ?? normalized.specs.torque;
  }

  normalized.specs.transmission = normalizeTransmission(normalized.specs.transmission) || normalized.specs.transmission;
  normalized.specs.fuelType = normalizeFuelType(normalized.specs.fuelType) || normalized.specs.fuelType;
  normalized.specs.bodyType = classifyStructuredBodyType(normalized.specs.bodyType, normalized.basic.model || '') || normalized.specs.bodyType;
  normalized.specs.drivetrain = normalizeDrivetrain(normalized.specs.drivetrain) || normalized.specs.drivetrain;

  return normalized;
}

function validate8891CarData(data: any): ValidationMessage[] {
  const messages: ValidationMessage[] = [];
  const basic = data?.basic;
  const specs = data?.specs;

  if (!basic || typeof basic !== 'object') {
    return [{ field: 'basic', message: '缺少 basic 欄位', type: 'error' }];
  }

  if (typeof basic.brand !== 'string' || basic.brand.length === 0) {
    messages.push({ field: 'basic.brand', message: '品牌為必填欄位', type: 'error' });
  }
  if (typeof basic.model !== 'string' || basic.model.length === 0) {
    messages.push({ field: 'basic.model', message: '型號為必填欄位', type: 'error' });
  }
  if (typeof basic.year !== 'number' || basic.year < 1900 || basic.year > 2030) {
    messages.push({ field: 'basic.year', message: '年份必須在 1900-2030 之間', type: 'error' });
  }
  if (basic.mileage === null || basic.mileage === undefined) {
    messages.push({ field: 'basic.mileage', message: '里程數未填寫（將跳過此欄位）', type: 'warning' });
  } else if (typeof basic.mileage !== 'number' || basic.mileage < 0) {
    messages.push({ field: 'basic.mileage', message: '里程數必須為非負數', type: 'error' });
  }
  if (basic.price === null || basic.price === undefined) {
    messages.push({ field: 'basic.price', message: '價格未填寫（將跳過此欄位）', type: 'warning' });
  } else if (typeof basic.price !== 'number' || basic.price < 0) {
    messages.push({ field: 'basic.price', message: '價格必須為非負數', type: 'error' });
  }

  if (specs && typeof specs === 'object') {
    const validTransmissions = ['automatic', 'manual', 'cvt', 'dct'];
    const validFuelTypes = ['gasoline', 'diesel', 'hybrid', 'electric', 'plugin_hybrid'];
    const validBodyTypes = ['sedan', 'suv', 'hatchback', 'coupe', 'convertible', 'wagon', 'van', 'truck', 'mpv'];
    const validDrivetrains = ['2WD', '4WD', 'AWD'];

    if (specs.transmission && !validTransmissions.includes(specs.transmission)) {
      messages.push({ field: 'specs.transmission', message: '無效的變速箱類型', type: 'error' });
    }
    if (specs.fuelType && !validFuelTypes.includes(specs.fuelType)) {
      messages.push({ field: 'specs.fuelType', message: '無效的燃料類型', type: 'error' });
    }
    if (specs.bodyType && !validBodyTypes.includes(specs.bodyType)) {
      messages.push({ field: 'specs.bodyType', message: '無效的車身類型', type: 'error' });
    }
    if (specs.drivetrain && !validDrivetrains.includes(specs.drivetrain)) {
      messages.push({ field: 'specs.drivetrain', message: '無效的驅動方式', type: 'error' });
    }
    if (specs.color === null || specs.color === undefined) {
      messages.push({ field: 'specs.color', message: '車色未填寫（將跳過此欄位）', type: 'warning' });
    }
  }

  return messages;
}

function finalize8891Content(content: string, car?: CarRecord): {
  content: string;
  validationHints: CopyReviewHint[];
  validationSummary: { status: 'ready' | 'warning' | 'error'; errorCount: number; warningCount: number };
} {
  const parsed = parseGeneratedJson(content);
  if (!parsed) {
    return {
      content,
      validationHints: [{ field: 'json', reason: '8891 內容不是合法 JSON，post-helper 無法使用。', severity: 'warning', suggestedValue: null }],
      validationSummary: { status: 'error', errorCount: 1, warningCount: 0 },
    };
  }

  const normalized = normalize8891Json(parsed);
  const validationMessages = validate8891CarData(normalized);
  if (car) {
    const explicitBodyType = inferExplicitBodyType(sanitizeModel(car.model || ''));
    if (explicitBodyType && normalized?.specs?.bodyType) {
      const actualBodyType = String(normalized.specs.bodyType);
      const compatibleBodyTypes = explicitBodyType === 'mpv' ? ['mpv', 'van'] : [explicitBodyType];
      if (!compatibleBodyTypes.includes(actualBodyType)) {
      validationMessages.push({
        field: 'specs.bodyType',
        message: `車身型式與車型線索衝突：此車較可能是 ${explicitBodyType}，目前輸出為 ${actualBodyType}`,
        type: 'error',
      });
      }
    }
  }
  const errorCount = validationMessages.filter(message => message.type === 'error').length;
  const warningCount = validationMessages.filter(message => message.type === 'warning').length;
  const validationHints = validationMessages.map(message => ({
    field: message.field,
    reason: message.message,
    severity: (message.type === 'error' ? 'warning' : 'info') as 'warning' | 'info',
    suggestedValue: null,
  }));

  return {
    content: JSON.stringify(normalized, null, 2),
    validationHints,
    validationSummary: {
      status: errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'ready',
      errorCount,
      warningCount,
    },
  };
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

  const normalizedOwner = normalizeOwner(car.owner);
  if (!normalizedOwner || !member || !isOwnerMatched(normalizedOwner, member)) {
    hints.push({
      field: 'contact',
      reason: '業務聯絡人無法由 owner 與 alias 唯一匹配取得，建議人工確認。',
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

function normalizeBrandForComparison(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/benz/g, 'mercedes')
    .replace(/rolls[-\s]*royce/g, 'rollsroyce')
    .replace(/^rr$/g, 'rollsroyce')
    .replace(/[^a-z]/g, '');
}

function normalizeModelForComparison(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isVinDecodeTrusted(car: CarRecord, vinDecode: VinDecodeRecord | null): boolean {
  if (!vinDecode) return false;

  const carYear = parseFirstInteger(car.year || '');
  const vinYear = parseFirstInteger(vinDecode.year || '');
  if (!carYear || !vinYear || Math.abs(carYear - vinYear) > 1) {
    return false;
  }

  const carBrand = normalizeBrandForComparison(car.brand || '');
  const vinBrand = normalizeBrandForComparison(vinDecode.make || '');
  if (!carBrand || !vinBrand || (!carBrand.includes(vinBrand) && !vinBrand.includes(carBrand))) {
    return false;
  }

  const carModel = normalizeModelForComparison(car.model || '');
  const vinModel = normalizeModelForComparison(vinDecode.model || '');
  if (!carModel || !vinModel || (!carModel.includes(vinModel) && !vinModel.includes(carModel))) {
    return false;
  }

  return true;
}

function parseFirstInteger(input: string): number | undefined {
  const match = (input || '').replace(/,/g, '').match(/\d+/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function parseMileage(input: string): number {
  const raw = (input || '').trim().replace(/,/g, '');
  if (!raw) return 0;

  if (raw.includes('萬')) {
    const value = Number(raw.replace('萬', ''));
    if (Number.isFinite(value)) return Math.round(value * 10000);
  }

  const numeric = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
}

function parsePrice(input: string): number {
  const value = parseFirstInteger(input || '');
  return value ?? 0;
}

function sanitizeBrand(value: string): string {
  return String(value || '')
    .replace(/[（(]([^)）]{1,20})[)）]/g, (full, inner) => {
      const text = String(inner || '').trim();
      const preserveMeaningfulChinese = /^(邁巴赫|勞斯萊斯|藍寶堅尼|法拉利|保時捷|麥拉倫|奧斯頓馬丁)$/u.test(text);
      const looksLikeMetadata = /^原.+/.test(text)
        || /^\d{1,4}$/.test(text)
        || /^[ABPT]\d{1,4}$/i.test(text)
        || /^(TW|JP|KR|韓國|日本|台灣)$/.test(text)
        || (!preserveMeaningfulChinese && /^[\u4e00-\u9fff]{2,4}$/u.test(text));
      return looksLikeMetadata ? '' : full;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeModel(value: string): string {
  return String(value || '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeTransmission(value?: string): 'automatic' | 'manual' | 'cvt' | 'dct' | undefined {
  const text = (value || '').toLowerCase();
  if (!text) return undefined;
  if (text.includes('manual') || text.includes('手排')) return 'manual';
  if (text.includes('cvt')) return 'cvt';
  if (text.includes('dct') || text.includes('dual') || text.includes('雙離合')) return 'dct';
  if (text.includes('automatic') || text.includes('auto') || text.includes('自排')) return 'automatic';
  return undefined;
}

function normalizeFuelType(value?: string): 'gasoline' | 'diesel' | 'hybrid' | 'electric' | 'plugin_hybrid' | undefined {
  const text = (value || '').toLowerCase();
  if (!text) return undefined;
  if (text.includes('plugin') || text.includes('phev')) return 'plugin_hybrid';
  if (text.includes('hybrid') || text.includes('油電')) return 'hybrid';
  if (text.includes('electric') || text.includes('ev') || text.includes('純電')) return 'electric';
  if (text.includes('diesel') || text.includes('柴油')) return 'diesel';
  if (text.includes('gasoline') || text.includes('petrol') || text.includes('汽油')) return 'gasoline';
  return undefined;
}

function normalizeBodyType(value?: string, model = ''): 'sedan' | 'suv' | 'hatchback' | 'coupe' | 'convertible' | 'wagon' | 'van' | 'truck' | 'mpv' | undefined {
  const text = `${value || ''} ${model}`.toLowerCase();
  const hasLmModel = /(?:^|\s|[-_/])(lm\d*[a-z]?)(?=$|\s|[-_/]|[ -]*|[ -])/i.test(text)
    || /lm\d+h/i.test(text);
  if (!text) return undefined;
  if (text.includes('convertible') || text.includes('spyder') || text.includes('spider') || text.includes('cabrio') || text.includes('敞篷')) return 'convertible';
  if (text.includes('mpv') || text.includes('lm500h') || text.includes('lm350h') || text.includes('lm300h') || text.includes('alphard') || text.includes('vellfire') || text.includes('odyssey') || text.includes('serena') || text.includes('sienna') || text.includes('carnival') || text.includes('v-class') || text.includes('v class') || text.includes('staria')) return 'mpv';
  if (text.includes('suv') || text.includes('cullinan') || text.includes('urus') || text.includes('cayenne')) return 'suv';
  if (text.includes('wagon') || text.includes('estate') || text.includes('旅行')) return 'wagon';
  if (text.includes('hatchback')) return 'hatchback';
  if (text.includes('van')) return 'van';
  if (text.includes('truck')) return 'truck';
  if (text.includes('coupe') || text.includes('gt') || text.includes('911') || text.includes('roma') || text.includes('f8')) return 'coupe';
  if (text.includes('sedan') || text.includes('ghost') || text.includes('flying spur') || text.includes('s-class')) return 'sedan';
  return undefined;
}

function normalizeDrivetrain(value?: string): '2WD' | '4WD' | 'AWD' | undefined {
  const text = (value || '').toUpperCase();
  if (!text) return undefined;
  if (text.includes('AWD')) return 'AWD';
  if (text.includes('4WD')) return '4WD';
  if (text.includes('2WD') || text.includes('RWD') || text.includes('FWD')) return '2WD';
  return undefined;
}

function pickConfirmedValue(fieldMap: Record<string, string[]>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fieldMap[key]?.[0];
    if (value) return value;
  }
  return undefined;
}

function inferExplicitBodyType(model: string): 'mpv' | 'suv' | 'coupe' | 'convertible' | undefined {
  const text = String(model || '').toLowerCase();
  if (!text) return undefined;

  const mpvMarkers = ['lm500h', 'lm350h', 'lm300h', 'alphard', 'vellfire', 'odyssey', 'serena', 'sienna', 'carnival', 'v-class', 'v class', 'staria'];
  if (mpvMarkers.some(marker => text.includes(marker))) return 'mpv';

  const suvMarkers = ['urus', 'cullinan', 'cayenne'];
  if (suvMarkers.some(marker => text.includes(marker))) return 'suv';

  const convertibleMarkers = ['spyder', 'spider', 'cabrio', '敞篷'];
  if (convertibleMarkers.some(marker => text.includes(marker))) return 'convertible';

  const coupeMarkers = ['coupe', '911', 'roma', 'f8'];
  if (coupeMarkers.some(marker => text.includes(marker))) return 'coupe';

  return undefined;
}

function classifyStructuredBodyType(value?: string, model = ''): 'sedan' | 'suv' | 'hatchback' | 'coupe' | 'convertible' | 'wagon' | 'van' | 'truck' | 'mpv' | undefined {
  const sourceText = String(value || '').toLowerCase();
  const modelText = String(model || '').toLowerCase();
  const combined = `${sourceText} ${modelText}`.trim();

  if (!combined) return undefined;

  if (sourceText.includes('convertible') || sourceText.includes('spyder') || sourceText.includes('spider') || sourceText.includes('cabrio') || sourceText.includes('敞篷')) return 'convertible';
  if (sourceText.includes('wagon') || sourceText.includes('estate') || sourceText.includes('旅行')) return 'wagon';
  if (sourceText.includes('hatchback')) return 'hatchback';
  if (sourceText.includes('van')) return 'van';
  if (sourceText.includes('truck')) return 'truck';
  if (sourceText.includes('mpv')) return 'mpv';
  if (sourceText.includes('suv') || sourceText.includes('cullinan') || sourceText.includes('urus') || sourceText.includes('cayenne')) return 'suv';
  if (sourceText.includes('coupe') || sourceText.includes('gt') || sourceText.includes('911') || sourceText.includes('roma') || sourceText.includes('f8')) return 'coupe';
  if (sourceText.includes('sedan') || sourceText.includes('ghost') || sourceText.includes('flying spur') || sourceText.includes('s-class')) return 'sedan';

  return inferExplicitBodyType(modelText);
}

function build8891DraftJson(car: CarRecord, member: TeamMember, vinDecode: VinDecodeRecord | null): string {
  const confirmed = getConfirmedVehicleFieldMap(car.item);
  const cleanBrand = sanitizeBrand(car.brand || '');
  const cleanModel = sanitizeModel(car.model || '');
  const explicitBodyType = inferExplicitBodyType(cleanModel || car.model || '');
  const draft = {
    basic: {
      brand: cleanBrand || car.brand || vinDecode?.make || '',
      model: cleanModel || vinDecode?.model || '',
      year: parseFirstInteger(car.year || vinDecode?.year || '') || 2020,
      mileage: parseMileage(car.mileage),
      price: 0,
    },
    specs: {
      color: car.exteriorColor || undefined,
      interiorColor: car.interiorColor || undefined,
      engineDisplacement: parseFirstInteger(pickConfirmedValue(confirmed, 'specs.engineDisplacement') || '')
        || (vinDecode?.engineDisplacementL ? Math.round(Number(vinDecode.engineDisplacementL) * 1000) : undefined),
      transmission: normalizeTransmission(
        pickConfirmedValue(confirmed, 'specs.transmission') || vinDecode?.transmissionStyle
      ),
      fuelType: normalizeFuelType(
        pickConfirmedValue(confirmed, 'specs.fuelType') || vinDecode?.fuelType
      ),
      bodyType: classifyStructuredBodyType(
        pickConfirmedValue(confirmed, 'specs.bodyType') || vinDecode?.bodyClass,
        cleanModel || car.model,
      ) || explicitBodyType,
      doors: parseFirstInteger(pickConfirmedValue(confirmed, 'specs.doors') || vinDecode?.doors || ''),
      seats: parseFirstInteger(pickConfirmedValue(confirmed, 'specs.seats') || ''),
      drivetrain: normalizeDrivetrain(
        pickConfirmedValue(confirmed, 'specs.drivetrain') || vinDecode?.driveType
      ),
      horsepower: parseFirstInteger(pickConfirmedValue(confirmed, 'specs.horsepower') || vinDecode?.horsepower || ''),
      torque: parseFirstInteger(pickConfirmedValue(confirmed, 'specs.torque') || ''),
      vin: car.vin || undefined,
    },
    contact: {
      name: member.name,
      mobile: member.phone,
      lineId: member.line_id,
      location: {
        city: '台北市',
        district: '內湖區',
        address: '行忠路57號',
      },
    },
    listing: {
      title: '',
      description: '',
      highlightFeatures: [] as string[],
    },
    metadata: {
      source: 'sheet-to-car',
      version: '1.5.0',
    },
  };

  return JSON.stringify(draft, null, 2);
}

async function buildGenerationInputs(car: CarRecord): Promise<GenerationInputs> {
  const member = findMemberByOwner(car.owner);
  if (!member) throw new Error(`No matched team member for owner '${car.owner || '(empty)'}'`);

  const rawVinDecode = await getVinDecodeForCar(car, true);
  const vinDecode = isVinDecodeTrusted(car, rawVinDecode) ? rawVinDecode : null;

  return {
    member,
    prefs: getUserPreferences(),
    vehicleContext: getConfirmedVehicleContext(car.item),
    vinDecode,
  };
}

function buildPrompt(car: CarRecord, platform: Platform, inputs: GenerationInputs): string {
  const customPrompt = getCustomPrompt();
  const contactBlock = buildContactBlock(inputs.member);
  const skills = getPlatformSkills(platform);
  const { prefs, vehicleContext, vinDecode } = inputs;
  const cleanBrand = sanitizeBrand(car.brand || '') || car.brand;
  const cleanModel = sanitizeModel(car.model || '');
  const explicitBodyType = inferExplicitBodyType(cleanModel || car.model || '');

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

  prompt += `\n\n## 可用聯絡資訊（是否使用、如何呈現，請遵循上方平台 Prompt 與額外指示）\n${contactBlock}`;

  prompt += `\n\n## 車輛資料
- 編號: ${car.item}
- 品牌: ${cleanBrand}
- 年式: ${car.year}
- 車型: ${cleanModel || car.model}
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

  if (vehicleContext.photoVisibleFindings.length > 0 || vehicleContext.photoSuggestedLines.length > 0) {
    prompt += `\n\n## 照片分析可用描述（可保守融入主文案，不可擴寫成未確認規格）`;
    const seenPhotoLines = new Set();
    for (const finding of vehicleContext.photoVisibleFindings) {
      const normalized = `照片可見：${finding}`.replace(/\s+/g, ' ').trim();
      if (seenPhotoLines.has(normalized)) continue;
      seenPhotoLines.add(normalized);
      prompt += `\n- ${normalized}`;
    }
    for (const line of vehicleContext.photoSuggestedLines) {
      const normalized = String(line || '').replace(/\s+/g, ' ').trim();
      if (!normalized || seenPhotoLines.has(normalized)) continue;
      seenPhotoLines.add(normalized);
      prompt += `\n- ${normalized}`;
    }
  }

  if (vehicleContext.pendingReviewFields.length > 0) {
    prompt += `\n\n## 尚未確認欄位（不可寫成已確認事實）\n- ${vehicleContext.pendingReviewFields.join('、')}`;
  }

  prompt += buildVinDecodeBlock(vinDecode);

  if (platform === '8891') {
    prompt += `\n\n## 8891 JSON Draft（已按 post-helper schema 預先組好，請保留整體結構，只補齊合理內容）\n${build8891DraftJson(car, inputs.member, vinDecode)}`;
    prompt += `\n\n重要：
- 請輸出與 draft 相同的 JSON 結構。
- basic/specs/contact 的已知欄位優先沿用 draft。
- 只在 listing.title / listing.description / listing.highlightFeatures 與少數缺值規格欄位做保守補充。
- 不要新增 post-helper schema 之外的欄位。
- 若欄位沒有足夠依據，保持 draft 的空值或既有值，不要硬編。`;
  }

  prompt += `\n\n請根據以上資料，生成${platform}平台的完整文案。直接輸出文案，不要加額外說明。`;

  return prompt;
}

/** Generate copy for a single platform */
export async function generateCopyWithMeta(car: CarRecord, platform: Platform): Promise<GeneratedCopyResult> {
  const inputs = await buildGenerationInputs(car);
  const skills = getPlatformSkills(platform);

  const prompt = buildPrompt(car, platform, inputs);

  const rawResult = await withGeminiRetry(async (apiKey) => {
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

  const finalized = platform === '8891'
    ? finalize8891Content(rawResult, car)
    : {
        content: mergePhotoSuggestedLines(platform, stripMarkdownCodeFence(rawResult), inputs.vehicleContext),
        validationHints: [] as CopyReviewHint[],
        validationSummary: { status: 'ready' as const, errorCount: 0, warningCount: 0 },
      };

  if (platform === '8891') {
    finalized.content = mergePhotoSuggestedLines(platform, finalized.content, inputs.vehicleContext);
  }

  // Remove existing draft to prevent duplicates
  db.prepare(`
    DELETE FROM car_copies 
    WHERE item = ? AND platform = ? AND status = 'draft'
  `).run(car.item, platform);

  const generationContext = {
    confirmedFeatureCount: inputs.vehicleContext.confirmedHighlights.length + inputs.vehicleContext.confirmedPhotoFindings.length,
    pendingFieldCount: inputs.vehicleContext.pendingReviewFields.length,
  };

  // Save to DB
  db.prepare(`
    INSERT INTO car_copies (
      item, platform, content, status, confirmed_feature_count, pending_field_count,
      validation_status, validation_error_count, validation_warning_count
    )
    VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)
  `).run(
    car.item,
    platform,
    finalized.content,
    generationContext.confirmedFeatureCount,
    generationContext.pendingFieldCount,
    finalized.validationSummary.status,
    finalized.validationSummary.errorCount,
    finalized.validationSummary.warningCount,
  );

  return {
    content: finalized.content,
    reviewHints: platform === '8891'
      ? [...build8891ReviewHints(car, inputs.member, finalized.content), ...finalized.validationHints]
      : [],
    activeSkills: skills.map(skill => skill.name),
    generationContext,
    validationSummary: finalized.validationSummary,
  };
}

export async function generateCopy(car: CarRecord, platform: Platform): Promise<string> {
  return (await generateCopyWithMeta(car, platform)).content;
}

/** Generate copies for all platforms */
export async function generateAllCopies(car: CarRecord): Promise<{
  results: Partial<Record<Platform, string>>;
  errors: Partial<Record<Platform, string>>;
}> {
  const inputs = await buildGenerationInputs(car);
  const results: Partial<Record<Platform, string>> = {};
  const errors: Partial<Record<Platform, string>> = {};
  for (const platform of PLATFORMS) {
    try {
      const prompt = buildPrompt(car, platform, inputs);
      const rawResult = await withGeminiRetry(async (apiKey) => {
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

      const finalized = platform === '8891'
        ? finalize8891Content(rawResult, car)
        : {
            content: mergePhotoSuggestedLines(platform, stripMarkdownCodeFence(rawResult), inputs.vehicleContext),
            validationHints: [] as CopyReviewHint[],
            validationSummary: { status: 'ready' as const, errorCount: 0, warningCount: 0 },
          };

      if (platform === '8891') {
        finalized.content = mergePhotoSuggestedLines(platform, finalized.content, inputs.vehicleContext);
      }

      db.prepare(`
        DELETE FROM car_copies 
        WHERE item = ? AND platform = ? AND status = 'draft'
      `).run(car.item, platform);

      db.prepare(`
        INSERT INTO car_copies (
          item, platform, content, status, confirmed_feature_count, pending_field_count,
          validation_status, validation_error_count, validation_warning_count
        )
        VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)
      `).run(
        car.item,
        platform,
        finalized.content,
        inputs.vehicleContext.confirmedHighlights.length + inputs.vehicleContext.confirmedPhotoFindings.length,
        inputs.vehicleContext.pendingReviewFields.length,
        finalized.validationSummary.status,
        finalized.validationSummary.errorCount,
        finalized.validationSummary.warningCount,
      );

      results[platform] = finalized.content;
    } catch (err: any) {
      errors[platform] = err.message || '生成失敗';
    }
  }

  return { results, errors };
}

/** Get existing copies for a car */
export function getCopies(item: string): Array<{
  id: number; platform: string; content: string; status: string;
  created_at: string; expires_at: string | null;
  confirmed_feature_count: number; pending_field_count: number;
  validation_status: string; validation_error_count: number; validation_warning_count: number;
}> {
  return db.prepare(
    'SELECT id, platform, content, status, created_at, expires_at, confirmed_feature_count, pending_field_count, validation_status, validation_error_count, validation_warning_count FROM car_copies WHERE item = ? ORDER BY created_at DESC'
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
