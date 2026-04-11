import { GoogleGenerativeAI } from '@google/generative-ai';
import db from '../db/connection';
import { CarRecord } from '../lib/sheets/types';
import { withGeminiRetry } from './geminiRetry';
import { getGeminiModel, trackUsage } from './geminiKeys';
import { getSkills } from './skillLoader';
import fs from 'fs';
import path from 'path';
import { getVinDecodeForCar, VinDecodeRecord } from './vinDecode';

export interface VehicleAnalysisRecord {
  item: string;
  status: string;
  baselineFindings: string[];
  reviewHints: Array<{ field: string; reason: string; severity: 'info' | 'warning'; suggestedValue?: string | null }>;
  recommendedPhotos: string[];
  suggestedIntroLines: string[];
  summaryText: string;
  lastError: string;
  updatedAt: string;
}

export interface VehiclePhotoAnalysisRecord {
  id: number;
  item: string;
  imagePaths: string[];
  findings: string[];
  reviewHints: Array<{ field: string; reason: string; severity: 'info' | 'warning'; suggestedValue?: string | null }>;
  suggestedCopyLines: string[];
  summaryText: string;
  createdAt: string;
}

export interface PendingVehicleAnalysisItem extends VehicleAnalysisRecord {
  car: Pick<CarRecord, 'item' | 'brand' | 'model' | 'year' | 'status'>;
  photoAnalysis: VehiclePhotoAnalysisRecord | null;
  totalReviewHints: number;
}

export interface ConfirmedVehicleContext {
  confirmedHighlights: string[];
  confirmedPhotoFindings: string[];
  photoVisibleFindings: string[];
  photoSuggestedLines: string[];
  photoReviewPending: boolean;
  pendingReviewFields: string[];
}

export interface ConfirmedVehicleFieldMap {
  [field: string]: string[];
}

interface ConfirmedFeatureRow {
  source: string;
  field: string;
  value: string;
}

export interface UploadedPhotoInput {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export type ReviewAcceptMode = 'supplement' | 'replace';

const REPLACEABLE_REVIEW_FIELDS = new Set([
  'specs.engineDisplacement',
  'specs.doors',
  'specs.seats',
  'specs.horsepower',
  'specs.torque',
]);

function canReplaceReviewField(field: string): boolean {
  return REPLACEABLE_REVIEW_FIELDS.has(field);
}

function isValidReplaceValue(field: string, value: string): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return false;

  if (Array.from(REPLACEABLE_REVIEW_FIELDS).includes(field)) {
    return /^\d+$/.test(normalized);
  }

  return false;
}

interface AnalysisPayload {
  baselineFindings?: string[];
  reviewHints?: Array<{ field: string; reason: string; severity: 'info' | 'warning'; suggestedValue?: string | null }>;
  recommendedPhotos?: string[];
  suggestedIntroLines?: string[];
  summaryText?: string;
}

function enrichWithVinDecodeHints(payload: Required<AnalysisPayload>, car: CarRecord, vinDecode: VinDecodeRecord | null): Required<AnalysisPayload> {
  if (!car.vin) {
    return payload;
  }

  if (!vinDecode) {
    const hasHint = payload.reviewHints.some(hint => hint.field === 'vin_decode');
    if (!hasHint) {
      payload.reviewHints.unshift({
        field: 'vin_decode',
        reason: '目前沒有取得 VIN decode 結果，8891 規格欄位會較依賴既有資料與人工確認。',
        severity: 'warning',
        suggestedValue: null,
      });
    }
    if (!payload.summaryText) {
      payload.summaryText = 'VIN decode 尚未取得，部分規格需人工確認。';
    }
    return payload;
  }

  if (vinDecode.engineDisplacementL) {
    payload.baselineFindings.unshift(`VIN decode 顯示排氣量約 ${vinDecode.engineDisplacementL}L`);
  }
  if (vinDecode.bodyClass) {
    payload.baselineFindings.unshift(`VIN decode 車身型式為 ${vinDecode.bodyClass}`);
  }

  return payload;
}

function buildSkillPrompt(): string {
  return getSkills(['source-grounding', 'vehicle-feature-baseline'])
    .map(skill => `## Active Skill: ${skill.name}\n${skill.content}`)
    .join('\n\n');
}

function buildPhotoSkillPrompt(): string {
  return getSkills(['source-grounding', 'photo-modification-review', 'user-confirmation-flow'])
    .map(skill => `## Active Skill: ${skill.name}\n${skill.content}`)
    .join('\n\n');
}

function getUploadRoot(): string {
  return path.resolve(__dirname, '../../data/vehicle-analysis-photos');
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function decodeDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('invalid image data');
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function normalizePayload(payload: AnalysisPayload): Required<AnalysisPayload> {
  return {
    baselineFindings: Array.isArray(payload.baselineFindings) ? payload.baselineFindings.slice(0, 6) : [],
    reviewHints: Array.isArray(payload.reviewHints) ? payload.reviewHints.slice(0, 8).map(hint => ({
      field: String(hint.field || 'feature'),
      reason: String(hint.reason || '需要人工確認'),
      severity: hint.severity === 'warning' ? 'warning' : 'info',
      suggestedValue: hint.suggestedValue == null ? null : String(hint.suggestedValue),
    })) : [],
    recommendedPhotos: Array.isArray(payload.recommendedPhotos) ? payload.recommendedPhotos.slice(0, 6) : [],
    suggestedIntroLines: Array.isArray(payload.suggestedIntroLines) ? payload.suggestedIntroLines.slice(0, 4) : [],
    summaryText: String(payload.summaryText || '').trim(),
  };
}

function buildFallbackAnalysis(car: CarRecord): Required<AnalysisPayload> {
  const findings: string[] = [];
  const hints: Required<AnalysisPayload>['reviewHints'] = [];
  const photos: string[] = [];
  const introLines: string[] = [];

  findings.push(`${car.year || '年份未填'} ${car.brand} ${car.model}`.trim());
  if (car.exteriorColor) findings.push(`外觀色為 ${car.exteriorColor}`);
  if (car.interiorColor) findings.push(`內裝色為 ${car.interiorColor}`);
  if (car.modification) findings.push(`表格備註有改裝/特色：${car.modification}`);

  if (car.modification) {
    hints.push({ field: 'modification', reason: '表格已有改裝資訊，建議補照片確認實車呈現。', severity: 'info', suggestedValue: car.modification });
    photos.push('請補 1 張能清楚看出改裝部位的細節照');
  } else {
    hints.push({ field: 'modification', reason: '目前沒有可直接確認的改裝資訊，若有外觀或內裝特色建議補照片。', severity: 'warning', suggestedValue: null });
  }

  photos.push('請補車頭或前 45 度照，方便判斷外觀套件與車型細節');
  photos.push('請補內裝照，方便確認座椅、縫線、飾板與特殊配備');
  photos.push('若有特仕版疑慮，請補車尾 badge 或銘牌細節');

  if (car.note) {
    introLines.push(`這台 ${car.brand} ${car.model} 除了基本規格完整，表格備註也提到 ${car.note}。`);
  } else {
    introLines.push(`這台 ${car.brand} ${car.model} 可先從年份、配色與車況亮點切入介紹。`);
  }

  return {
    baselineFindings: findings,
    reviewHints: hints,
    recommendedPhotos: photos,
    suggestedIntroLines: introLines,
    summaryText: hints.length > 0 ? `這台車有 ${hints.length} 個值得補確認的特徵。` : '這台車已完成基礎特徵分析。',
  };
}

function parseAnalysisResponse(raw: string, car: CarRecord): Required<AnalysisPayload> {
  try {
    const parsed = JSON.parse(raw);
    return normalizePayload(parsed);
  } catch {
    return buildFallbackAnalysis(car);
  }
}

function upsertAnalysis(item: string, status: string, payload: Required<AnalysisPayload>, lastError = ''): void {
  db.prepare(`
    INSERT INTO vehicle_analysis (
      item, status, baseline_findings_json, review_hints_json, recommended_photos_json,
      suggested_intro_lines_json, summary_text, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(item) DO UPDATE SET
      status = excluded.status,
      baseline_findings_json = excluded.baseline_findings_json,
      review_hints_json = excluded.review_hints_json,
      recommended_photos_json = excluded.recommended_photos_json,
      suggested_intro_lines_json = excluded.suggested_intro_lines_json,
      summary_text = excluded.summary_text,
      last_error = excluded.last_error,
      updated_at = datetime('now')
  `).run(
    item,
    status,
    JSON.stringify(payload.baselineFindings),
    JSON.stringify(payload.reviewHints),
    JSON.stringify(payload.recommendedPhotos),
    JSON.stringify(payload.suggestedIntroLines),
    payload.summaryText,
    lastError,
  );
}

function mapRow(row: any): VehicleAnalysisRecord {
  return {
    item: row.item,
    status: row.status,
    baselineFindings: JSON.parse(row.baseline_findings_json || '[]'),
    reviewHints: JSON.parse(row.review_hints_json || '[]'),
    recommendedPhotos: JSON.parse(row.recommended_photos_json || '[]'),
    suggestedIntroLines: JSON.parse(row.suggested_intro_lines_json || '[]'),
    summaryText: row.summary_text || '',
    lastError: row.last_error || '',
    updatedAt: row.updated_at,
  };
}

function mapPhotoRow(row: any): VehiclePhotoAnalysisRecord {
  return {
    id: row.id,
    item: row.item,
    imagePaths: JSON.parse(row.image_paths_json || '[]'),
    findings: JSON.parse(row.findings_json || '[]'),
    reviewHints: JSON.parse(row.review_hints_json || '[]'),
    suggestedCopyLines: JSON.parse(row.suggested_copy_lines_json || '[]'),
    summaryText: row.summary_text || '',
    createdAt: row.created_at,
  };
}

function appendUniqueText(existing: string, next: string): string {
  const base = (existing || '').trim();
  const addition = (next || '').trim();
  if (!addition) return base;
  if (!base) return addition;
  if (base.includes(addition)) return base;
  return `${base} | ${addition}`;
}

function buildAnalysisPrompt(car: CarRecord): string {
  return `${buildSkillPrompt()}\n\n你是一個豪華車銷售支援分析器。請根據提供的車輛資料，輸出 JSON，協助業務先掌握這台新車有哪些亮點、哪些資訊需要補確認，以及最值得補哪些照片。\n\n限制：\n- 不要把沒有證據的內容講成已確認事實。\n- 如果只知道可能有特點，應寫成 review hint。\n- 不要輸出 markdown。只輸出 JSON。\n\nJSON 結構：\n{\n  "baselineFindings": ["..."],\n  "reviewHints": [{"field":"...","reason":"...","severity":"info|warning","suggestedValue":null}],\n  "recommendedPhotos": ["..."],\n  "suggestedIntroLines": ["..."],\n  "summaryText": "..."\n}\n\n車輛資料：\n- item: ${car.item}\n- brand: ${car.brand}\n- model: ${car.model}\n- year: ${car.year}\n- mileage: ${car.mileage || '未提供'}\n- vin: ${car.vin || '未提供'}\n- status: ${car.status || '未提供'}\n- exteriorColor: ${car.exteriorColor || '未提供'}\n- interiorColor: ${car.interiorColor || '未提供'}\n- modification: ${car.modification || '未提供'}\n- note: ${car.note || '未提供'}\n- owner: ${car.owner || '未提供'}\n- price: ${car.price || '未提供'}\n`;
}

function buildVinDecodeText(vinDecode: VinDecodeRecord | null): string {
  if (!vinDecode) return '';

  return [
    '',
    'VIN decode:',
    `- make: ${vinDecode.make || '未提供'}`,
    `- model: ${vinDecode.model || '未提供'}`,
    `- year: ${vinDecode.year || '未提供'}`,
    `- engineDisplacementL: ${vinDecode.engineDisplacementL || '未提供'}`,
    `- fuelType: ${vinDecode.fuelType || '未提供'}`,
    `- horsepower: ${vinDecode.horsepower || '未提供'}`,
    `- driveType: ${vinDecode.driveType || '未提供'}`,
    `- bodyClass: ${vinDecode.bodyClass || '未提供'}`,
    `- doors: ${vinDecode.doors || '未提供'}`,
    `- transmissionStyle: ${vinDecode.transmissionStyle || '未提供'}`,
    '',
  ].join('\n');
}

export async function runBaselineAnalysis(car: CarRecord): Promise<VehicleAnalysisRecord> {
  const vinDecode = await getVinDecodeForCar(car, true);
  const prompt = `${buildAnalysisPrompt(car)}${buildVinDecodeText(vinDecode)}`;

  try {
    const raw = await withGeminiRetry(async (apiKey) => {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({ model: getGeminiModel() });
      const resp = await model.generateContent(prompt);
      if (resp.response.usageMetadata) {
        trackUsage(apiKey, getGeminiModel(), 'vehicle-analysis', resp.response.usageMetadata);
      }
      return resp.response.text();
    });

    const payload = enrichWithVinDecodeHints(parseAnalysisResponse(raw, car), car, vinDecode);
    const status = payload.reviewHints.length > 0 ? 'needs_attention' : 'baseline_done';
    upsertAnalysis(car.item, status, payload, '');
    return getVehicleAnalysis(car.item)!;
  } catch (err: any) {
    const fallback = enrichWithVinDecodeHints(buildFallbackAnalysis(car), car, vinDecode);
    upsertAnalysis(car.item, 'needs_attention', fallback, err.message || 'analysis failed');
    return getVehicleAnalysis(car.item)!;
  }
}

function buildPhotoAnalysisPrompt(car: CarRecord): string {
  return `${buildPhotoSkillPrompt()}\n\n你是一個豪華車照片分析器。請依據車輛基本資料與使用者提供的照片，輸出 JSON，協助判斷這台車有哪些可見特色、疑似改裝、疑似特仕版線索，以及哪些地方仍需要人工確認。\n\n限制：\n- 只能描述照片中看得到的內容。\n- 不可把不確定的改裝或特仕版本寫成已確認事實。\n- 若角度不足，應明確說明還缺什麼照片。\n- 只輸出 JSON，不要 markdown。\n\nJSON 結構：\n{\n  "findings": ["..."],\n  "reviewHints": [{"field":"...","reason":"...","severity":"info|warning","suggestedValue":null}],\n  "suggestedCopyLines": ["..."],\n  "summaryText": "..."\n}\n\n車輛資料：\n- item: ${car.item}\n- brand: ${car.brand}\n- model: ${car.model}\n- year: ${car.year}\n- exteriorColor: ${car.exteriorColor || '未提供'}\n- interiorColor: ${car.interiorColor || '未提供'}\n- modification: ${car.modification || '未提供'}\n- note: ${car.note || '未提供'}\n- vin: ${car.vin || '未提供'}\n`;
}

function buildFallbackPhotoAnalysis(car: CarRecord, photoCount: number): Omit<VehiclePhotoAnalysisRecord, 'id' | 'item' | 'imagePaths' | 'createdAt'> {
  return {
    findings: [`已收到 ${photoCount} 張照片，可進一步人工比對 ${car.brand} ${car.model} 的外觀與內裝細節。`],
    reviewHints: [{
      field: 'photo_review',
      reason: '照片已上傳，但 AI 未能穩定輸出可直接採用的結論，建議人工檢視或重新分析。',
      severity: 'warning',
      suggestedValue: null,
    }],
    suggestedCopyLines: [`這台 ${car.brand} ${car.model} 從照片中可見一些值得補充的外觀或內裝細節，建議人工確認後加入介紹。`],
    summaryText: '照片已上傳，但目前仍需要人工確認照片中的改裝或特仕特徵。',
  };
}

function parsePhotoAnalysisResponse(raw: string, car: CarRecord, photoCount: number): Omit<VehiclePhotoAnalysisRecord, 'id' | 'item' | 'imagePaths' | 'createdAt'> {
  try {
    const parsed = JSON.parse(raw);
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 8) : [],
      reviewHints: Array.isArray(parsed.reviewHints) ? parsed.reviewHints.slice(0, 10).map((hint: any) => ({
        field: String(hint.field || 'photo_feature'),
        reason: String(hint.reason || '需要人工確認'),
        severity: hint.severity === 'warning' ? 'warning' : 'info',
        suggestedValue: hint.suggestedValue == null ? null : String(hint.suggestedValue),
      })) : [],
      suggestedCopyLines: Array.isArray(parsed.suggestedCopyLines) ? parsed.suggestedCopyLines.slice(0, 5) : [],
      summaryText: String(parsed.summaryText || '').trim(),
    };
  } catch {
    return buildFallbackPhotoAnalysis(car, photoCount);
  }
}

function persistUploadedPhotos(item: string, uploads: UploadedPhotoInput[]): { imagePaths: string[]; modelParts: Array<{ inlineData: { mimeType: string; data: string } }> } {
  const itemDir = path.join(getUploadRoot(), item);
  ensureDirectory(itemDir);

  const imagePaths: string[] = [];
  const modelParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

  uploads.forEach((upload, index) => {
    const decoded = decodeDataUrl(upload.dataUrl);
    const ext = decoded.mimeType.split('/')[1] || 'jpg';
    const filename = `${Date.now()}_${index}_${sanitizeFilename(upload.name || 'photo')}.${ext}`;
    const fullPath = path.join(itemDir, filename);
    fs.writeFileSync(fullPath, Buffer.from(decoded.data, 'base64'));
    imagePaths.push(fullPath);
    modelParts.push({ inlineData: { mimeType: decoded.mimeType, data: decoded.data } });
  });

  return { imagePaths, modelParts };
}

function savePhotoAnalysis(item: string, imagePaths: string[], payload: Omit<VehiclePhotoAnalysisRecord, 'id' | 'item' | 'imagePaths' | 'createdAt'>): VehiclePhotoAnalysisRecord {
  const result = db.prepare(`
    INSERT INTO vehicle_photo_analysis (
      item, image_paths_json, findings_json, review_hints_json, suggested_copy_lines_json, summary_text
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    item,
    JSON.stringify(imagePaths),
    JSON.stringify(payload.findings),
    JSON.stringify(payload.reviewHints),
    JSON.stringify(payload.suggestedCopyLines),
    payload.summaryText,
  );

  const row = db.prepare('SELECT * FROM vehicle_photo_analysis WHERE id = ?').get(result.lastInsertRowid) as any;
  return mapPhotoRow(row);
}

export function getLatestPhotoAnalysis(item: string): VehiclePhotoAnalysisRecord | null {
  const row = db.prepare('SELECT * FROM vehicle_photo_analysis WHERE item = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(item) as any;
  return row ? mapPhotoRow(row) : null;
}

export function getConfirmedVehicleContext(item: string): ConfirmedVehicleContext {
  const rows = db.prepare('SELECT source, field, value FROM vehicle_confirmed_features WHERE item = ? ORDER BY updated_at DESC, id DESC').all(item) as ConfirmedFeatureRow[];
  const baseline = rows.filter(row => row.source === 'baseline').map(row => `已確認 ${row.field}：${row.value}`);
  const photo = rows.filter(row => row.source === 'photo').map(row => `已確認 ${row.field}：${row.value}`);
  const baseAnalysis = getVehicleAnalysis(item);
  const photoAnalysis = getLatestPhotoAnalysis(item);

  return {
    confirmedHighlights: baseline,
    confirmedPhotoFindings: photo,
    photoVisibleFindings: Array.from(new Set(photoAnalysis?.findings || [])),
    photoSuggestedLines: Array.from(new Set(photoAnalysis?.suggestedCopyLines || [])),
    photoReviewPending: (photoAnalysis?.reviewHints || []).length > 0,
    pendingReviewFields: Array.from(new Set([
      ...(baseAnalysis?.reviewHints || []).map(hint => hint.field),
      ...(photoAnalysis?.reviewHints || []).map(hint => hint.field),
    ])),
  };
}

export function getConfirmedVehicleFieldMap(item: string): ConfirmedVehicleFieldMap {
  const rows = db.prepare('SELECT field, value FROM vehicle_confirmed_features WHERE item = ? ORDER BY updated_at DESC, id DESC').all(item) as Array<{ field: string; value: string }>;
  const result: ConfirmedVehicleFieldMap = {};

  for (const row of rows) {
    if (!result[row.field]) result[row.field] = [];
    if (!result[row.field].includes(row.value)) {
      result[row.field].push(row.value);
    }
  }

  return result;
}

function upsertConfirmedFeature(item: string, source: 'baseline' | 'photo', field: string, value: string, mode: ReviewAcceptMode): void {
  const normalized = value.trim();
  if (!normalized) return;

  if (mode === 'replace') {
    db.prepare('DELETE FROM vehicle_confirmed_features WHERE item = ? AND field = ?').run(item, field);
  }

  db.prepare(`
    INSERT INTO vehicle_confirmed_features (item, source, field, value, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(item, source, field, value) DO UPDATE SET updated_at = datetime('now')
  `).run(item, source, field, normalized);
}

export async function analyzeVehiclePhotos(car: CarRecord, uploads: UploadedPhotoInput[]): Promise<VehiclePhotoAnalysisRecord> {
  if (uploads.length === 0) {
    throw new Error('至少需要 1 張照片');
  }
  if (uploads.length > 8) {
    throw new Error('一次最多分析 8 張照片');
  }

  const { imagePaths, modelParts } = persistUploadedPhotos(car.item, uploads);
  const prompt = buildPhotoAnalysisPrompt(car);

  try {
    const raw = await withGeminiRetry(async (apiKey) => {
      const genai = new GoogleGenerativeAI(apiKey);
      const model = genai.getGenerativeModel({ model: getGeminiModel() });
      const resp = await model.generateContent([{ text: prompt }, ...modelParts]);
      if (resp.response.usageMetadata) {
        trackUsage(apiKey, getGeminiModel(), 'vehicle-photo-analysis', resp.response.usageMetadata);
      }
      return resp.response.text();
    });

    const payload = parsePhotoAnalysisResponse(raw, car, uploads.length);
    return savePhotoAnalysis(car.item, imagePaths, payload);
  } catch {
    const fallback = buildFallbackPhotoAnalysis(car, uploads.length);
    return savePhotoAnalysis(car.item, imagePaths, fallback);
  }
}

export function markAnalysisPending(item: string): void {
  db.prepare(`
    INSERT INTO vehicle_analysis (item, status, updated_at)
    VALUES (?, 'pending', datetime('now'))
    ON CONFLICT(item) DO UPDATE SET status = 'pending', updated_at = datetime('now'), last_error = ''
  `).run(item);
}

export function getVehicleAnalysis(item: string): VehicleAnalysisRecord | null {
  const row = db.prepare('SELECT * FROM vehicle_analysis WHERE item = ?').get(item) as any;
  return row ? mapRow(row) : null;
}

export function getPendingVehicleAnalyses(): Array<VehicleAnalysisRecord & { car: Pick<CarRecord, 'item' | 'brand' | 'model' | 'year' | 'status'> }> {
  const rows = db.prepare(`
    SELECT va.*, c.item as car_item, c.brand as car_brand, c.model as car_model, c.year as car_year, c.status as car_status
    FROM vehicle_analysis va
    JOIN cars c ON c.item = va.item
    WHERE va.status IN ('pending', 'needs_attention')
    ORDER BY va.updated_at DESC
  `).all() as any[];

  return rows.map(row => {
    const base = mapRow(row);
    const photo = getLatestPhotoAnalysis(row.item);
    const totalReviewHints = base.reviewHints.length + (photo?.reviewHints.length || 0);
    const summaryText = photo?.reviewHints?.length
      ? photo.summaryText || base.summaryText
      : base.summaryText;

    return {
      ...base,
      summaryText,
      car: {
        item: row.car_item,
        brand: row.car_brand,
        model: row.car_model,
        year: row.car_year,
        status: row.car_status,
      },
      photoAnalysis: photo,
      totalReviewHints,
    };
  });
}

export async function processPendingVehicleAnalyses(cars: CarRecord[]): Promise<void> {
  for (const car of cars) {
    const current = getVehicleAnalysis(car.item);
    if (current && current.status !== 'pending') {
      continue;
    }

    await runBaselineAnalysis(car);
  }
}

function updateAnalysisStatus(item: string): void {
  const base = getVehicleAnalysis(item);
  const photo = getLatestPhotoAnalysis(item);
  if (!base) return;

  const unresolved = base.reviewHints.length + (photo?.reviewHints.length || 0);
  const status = unresolved > 0 ? 'needs_attention' : 'baseline_done';
  db.prepare('UPDATE vehicle_analysis SET status = ?, updated_at = datetime(\'now\') WHERE item = ?').run(status, item);
}

function replaceTaggedLineBlock(text: string, field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) return text;

  const prefix = `${field}:`;
  const source = String(text || '');
  const tokens = source.split(/(\s*\|\s*|\n)/);
  const rebuilt: string[] = [];
  let pendingDelimiter = '';
  let replaced = false;

  const flushDelimiter = () => {
    if (pendingDelimiter && rebuilt.length > 0) {
      rebuilt.push(pendingDelimiter);
    }
    pendingDelimiter = '';
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (index % 2 === 1) {
      pendingDelimiter = token;
      continue;
    }

    const segment = token.trim();
    if (!segment) continue;

    if (segment.startsWith(prefix)) {
      if (!replaced) {
        flushDelimiter();
        rebuilt.push(`${prefix} ${normalized}`);
        replaced = true;
      }
      pendingDelimiter = '';
      continue;
    }

    flushDelimiter();
    rebuilt.push(segment);
  }

  if (!replaced) {
    const delimiter = source.includes('\n') ? '\n' : (source.trim() ? ' | ' : '');
    if (delimiter && rebuilt.length > 0) rebuilt.push(delimiter);
    rebuilt.push(`${prefix} ${normalized}`);
  }

  return rebuilt.join('');
}

function updateCarFieldFromReview(item: string, field: string, value: string, mode: ReviewAcceptMode): void {
  const normalized = value.trim();
  if (!normalized) return;

  if (field === 'modification' || field === 'photo_feature') {
    const row = db.prepare('SELECT modification, note FROM cars WHERE item = ?').get(item) as any;
    if (!row) return;
    const nextModification = appendUniqueText(row.modification || '', normalized);
    db.prepare('UPDATE cars SET modification = ?, updated_at = datetime(\'now\') WHERE item = ?').run(nextModification, item);
    return;
  }

  if (field.startsWith('specs.') || field === 'contact') {
    const row = db.prepare('SELECT note FROM cars WHERE item = ?').get(item) as any;
    if (!row) return;
    const nextNote = mode === 'replace'
      ? replaceTaggedLineBlock(row.note || '', field, normalized)
      : appendUniqueText(row.note || '', `${field}: ${normalized}`);
    db.prepare('UPDATE cars SET note = ?, updated_at = datetime(\'now\') WHERE item = ?').run(nextNote, item);
  }
}

function removeHintAndMaybePromote(
  hints: Array<{ field: string; reason: string; severity: 'info' | 'warning'; suggestedValue?: string | null }>,
  findings: string[],
  hintField: string,
  hintReason: string,
  decision: 'accept' | 'ignore',
  value: string,
  acceptMode: ReviewAcceptMode
): {
  reviewHints: Array<{ field: string; reason: string; severity: 'info' | 'warning'; suggestedValue?: string | null }>;
  findings: string[];
} {
  const nextHints = hints.filter(hint => !(hint.field === hintField && hint.reason === hintReason));
  const nextFindings = decision === 'accept' && acceptMode === 'replace'
    ? findings.filter(line => line !== `已確認 ${hintField}：${value.trim()}` && !line.startsWith(`已確認 ${hintField}：`))
    : [...findings];

  if (decision === 'accept' && value.trim()) {
    const line = hintField === 'modification' || hintField === 'photo_feature'
      ? `已確認特色：${value.trim()}`
      : `已確認 ${hintField}：${value.trim()}`;
    if (!nextFindings.includes(line)) {
      nextFindings.unshift(line);
    }
  }

  return { reviewHints: nextHints, findings: nextFindings };
}

function removeConfirmedFindingLines(findings: string[], field: string): string[] {
  return findings.filter(line => !line.startsWith(`已確認 ${field}：`));
}

function scrubReplaceArtifactsInOtherSource(item: string, source: 'baseline' | 'photo', field: string): void {
  if (source === 'baseline') {
    const currentPhoto = getLatestPhotoAnalysis(item);
    if (!currentPhoto) return;
    const nextFindings = removeConfirmedFindingLines(currentPhoto.findings, field);
    db.prepare('UPDATE vehicle_photo_analysis SET findings_json = ?, summary_text = ? WHERE id = ?').run(
      JSON.stringify(nextFindings),
      currentPhoto.reviewHints.length > 0 ? `照片分析仍有 ${currentPhoto.reviewHints.length} 個待確認項目。` : '照片分析待確認項目已處理完成。',
      currentPhoto.id,
    );
    return;
  }

  const currentBaseline = getVehicleAnalysis(item);
  if (!currentBaseline) return;
  const nextFindings = removeConfirmedFindingLines(currentBaseline.baselineFindings, field);
  db.prepare('UPDATE vehicle_analysis SET baseline_findings_json = ?, summary_text = ?, updated_at = datetime(\'now\') WHERE item = ?').run(
    JSON.stringify(nextFindings),
    currentBaseline.reviewHints.length > 0 ? `這台車還有 ${currentBaseline.reviewHints.length} 個待確認特徵。` : '這台車的基礎分析待確認項目已處理完成。',
    item,
  );
}

export function applyReviewDecision(
  item: string,
  source: 'baseline' | 'photo',
  field: string,
  reason: string,
  decision: 'accept' | 'ignore',
  value: string,
  acceptMode: ReviewAcceptMode = 'supplement'
): { analysis: VehicleAnalysisRecord | null; photoAnalysis: VehiclePhotoAnalysisRecord | null } {
  if (decision === 'accept' && !value.trim()) {
    throw new Error('accepted review requires a confirmed value');
  }

  if (acceptMode === 'replace' && !canReplaceReviewField(field)) {
    throw new Error('replace mode is only supported for structured fields');
  }

  if (acceptMode === 'replace' && !isValidReplaceValue(field, value)) {
    throw new Error('replace value is not valid for this structured field');
  }

  if (source === 'baseline') {
    const current = getVehicleAnalysis(item);
    if (!current) throw new Error('analysis not found');

    const updated = removeHintAndMaybePromote(current.reviewHints, current.baselineFindings, field, reason, decision, value, acceptMode);
    db.prepare(`
      UPDATE vehicle_analysis
      SET review_hints_json = ?, baseline_findings_json = ?, summary_text = ?, updated_at = datetime('now')
      WHERE item = ?
    `).run(
      JSON.stringify(updated.reviewHints),
      JSON.stringify(updated.findings),
      updated.reviewHints.length > 0 ? `這台車還有 ${updated.reviewHints.length} 個待確認特徵。` : '這台車的基礎分析待確認項目已處理完成。',
      item,
    );
  } else {
    const current = getLatestPhotoAnalysis(item);
    if (!current) throw new Error('photo analysis not found');

    const updated = removeHintAndMaybePromote(current.reviewHints, current.findings, field, reason, decision, value, acceptMode);
    db.prepare(`
      UPDATE vehicle_photo_analysis
      SET review_hints_json = ?, findings_json = ?, summary_text = ?
      WHERE id = ?
    `).run(
      JSON.stringify(updated.reviewHints),
      JSON.stringify(updated.findings),
      updated.reviewHints.length > 0 ? `照片分析仍有 ${updated.reviewHints.length} 個待確認項目。` : '照片分析待確認項目已處理完成。',
      current.id,
    );
  }

  if (decision === 'accept') {
    updateCarFieldFromReview(item, field, value, acceptMode);
    upsertConfirmedFeature(item, source, field, value, acceptMode);
    if (acceptMode === 'replace') {
      scrubReplaceArtifactsInOtherSource(item, source, field);
    }
  }

  updateAnalysisStatus(item);

  return {
    analysis: getVehicleAnalysis(item),
    photoAnalysis: getLatestPhotoAnalysis(item),
  };
}
