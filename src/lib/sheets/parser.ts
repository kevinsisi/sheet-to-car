import { CarRecord } from './types';

/** Detect color type from cell background */
export function getColorType(bgColor: any): string {
  if (!bgColor) return '白色';
  const r = (bgColor.red || 0);
  const g = (bgColor.green || 0);
  const b = (bgColor.blue || 0);
  if (r > 0.95 && g > 0.95 && b > 0.95) return '白色';
  if (r > 0.99 && g < 0.01 && b > 0.99) return '紫紅';
  if (r > 0.99 && g > 0.9 && b > 0.7 && b < 0.85) return '淺黃';
  if (r > 0.7 && g < 0.5 && b < 0.5) return '紅色';
  if (r > 0.8 && g < 0.8 && b < 0.8 && r > g && r > b) return '淺紅';
  return '其他';
}

/** Map color to vehicle status */
export function getStatusFromColor(color: string, textStatus: string): string {
  if (color === '紅色' || color === '淺紅') return '已售出';
  if (color === '淺黃') return '新到貨';
  if (color === '紫紅') return '特殊';
  if (textStatus === 'Sold') return '已售出';
  if (textStatus === '海運') return '海運中';
  if (textStatus === '驗車' || textStatus === '驗車完成') return '驗車中';
  return '在庫';
}

/** Determine source type from item prefix */
export function getSourceType(item: string): string {
  if (/^B\d+/.test(item)) return '寄賣';
  if (/^T\d+/.test(item)) return '託售';
  if (/^A\d+/.test(item)) return '台灣車';
  if (/^P\d+/.test(item)) return '國外進口';
  if (/^\d+$/.test(item)) return '國外進口';
  return '其他';
}

/** Parse interior color, separating color from modification info */
export function parseInteriorColor(raw: string): { color: string; modification: string } {
  if (!raw) return { color: '', modification: '' };

  const bracketMatch = raw.match(/^([^(（]+)[(（](.+)[)）]$/);
  if (bracketMatch) {
    return { color: bracketMatch[1].trim(), modification: bracketMatch[2].trim() };
  }

  const spaceMatch = raw.match(/^([^\s]+)\s+(Mansory|V-Specification|BB版|BB|Bespok)(.*)$/i);
  if (spaceMatch) {
    return { color: spaceMatch[1].trim(), modification: (spaceMatch[2] + (spaceMatch[3] || '')).trim() };
  }

  return { color: raw.trim(), modification: '' };
}

/** Parse source sheet rows into CarRecords */
export function parseSourceRows(sourceRows: any[]): CarRecord[] {
  const cars: CarRecord[] = [];
  const seenItems = new Set<string>();

  sourceRows.forEach((row: any, idx: number) => {
    if (idx < 2) return;
    const cells = row.values || [];
    const item = cells[0]?.formattedValue?.trim() || '';

    if (!item || item === 'item' || item === '台灣' || item === '寄賣') return;
    if (seenItems.has(item)) return;

    const bgColor = getColorType(cells[0]?.effectiveFormat?.backgroundColor);
    const textStatus = cells[9]?.formattedValue || '';
    const rawInterior = cells[12]?.formattedValue || '';
    const { color: interiorColor, modification } = parseInteriorColor(rawInterior);

    seenItems.add(item);

    cars.push({
      item,
      source: getSourceType(item),
      brand: cells[2]?.formattedValue || '',
      year: cells[3]?.formattedValue || '',
      manufactureDate: cells[4]?.formattedValue || '',
      mileage: cells[5]?.formattedValue || '',
      model: cells[6]?.formattedValue || '',
      vin: cells[7]?.formattedValue || '',
      condition: cells[8]?.formattedValue || '',
      status: getStatusFromColor(bgColor, textStatus),
      exteriorColor: cells[11]?.formattedValue || '',
      interiorColor,
      modification,
      note: cells[10]?.formattedValue || '',
      poStatus: '未PO',
      poOfficial: false,
      po8891: false,
      poFacebook: false,
      poPostHelper: false,
      owner: '',
      price: '',
      bgColor,
    });
  });

  return cars;
}

/** Merge inventory sheet data into existing car records */
export function mergeInventoryRows(cars: CarRecord[], invRows: any[]): void {
  const invHeader = invRows[0]?.values || [];
  let assignIdx = -1;
  invHeader.forEach((cell: any, i: number) => {
    if ((cell?.formattedValue?.trim() || '') === '分配') assignIdx = i;
  });

  invRows.forEach((row: any, idx: number) => {
    if (idx < 1) return;
    const cells = row.values || [];
    const item = cells[0]?.formattedValue?.trim() || '';
    if (!item || item === 'item' || item === '台灣' || item === '寄賣') return;

    const existing = cars.find(c => c.item === item);
    if (!existing) return;

    const invCondition = cells[8]?.formattedValue || '';
    if (invCondition && invCondition !== '車況') existing.condition = invCondition;

    const invExtColor = cells[11]?.formattedValue || '';
    if (invExtColor && !existing.exteriorColor) existing.exteriorColor = invExtColor;

    const rawInterior = cells[12]?.formattedValue || '';
    if (rawInterior) {
      const { color, modification } = parseInteriorColor(rawInterior);
      if (color && !existing.interiorColor) existing.interiorColor = color;
      if (modification && !existing.modification) existing.modification = modification;
    }

    const invNote = cells[10]?.formattedValue || '';
    if (invNote) {
      existing.note = existing.note && existing.note !== invNote
        ? existing.note + ' | ' + invNote
        : invNote;
    }

    const invPrice = cells[17]?.formattedValue || '';
    if (invPrice) existing.price = invPrice;

    if (assignIdx >= 0) {
      const owner = cells[assignIdx]?.formattedValue?.trim() || '';
      if (owner) existing.owner = owner;
    }
  });
}
