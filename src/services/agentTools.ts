import { SchemaType, FunctionDeclaration } from '@google/generative-ai';
import { getCars, getStats, setPoStatus } from './carInventory';
import { CarRecord } from '../lib/sheets/types';

/** Tool definitions for Gemini function calling */
export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_cars',
    description: '搜尋車輛庫存，可依品牌、狀態、年份、型號等條件篩選',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        brand: { type: SchemaType.STRING, description: '品牌名稱，如 BMW, Porsche, Mercedes' },
        status: { type: SchemaType.STRING, description: '車輛狀態：在庫、新到貨、海運中、驗車中、已售出、特殊' },
        year: { type: SchemaType.STRING, description: '年式' },
        model: { type: SchemaType.STRING, description: '車型' },
        poStatus: { type: SchemaType.STRING, description: 'PO狀態：未PO、部分PO、已PO、不需PO' },
        query: { type: SchemaType.STRING, description: '自由搜尋關鍵字' },
      },
    },
  },
  {
    name: 'get_stats',
    description: '取得庫存統計，包含各狀態數量、品牌分佈、來源分佈、PO狀態統計',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'update_po',
    description: '更新車輛 PO 狀態。需要車輛編號（item）和新的 PO 狀態',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        item: { type: SchemaType.STRING, description: '車輛編號' },
        poStatus: { type: SchemaType.STRING, description: 'PO狀態：未PO、部分PO、已PO、不需PO' },
      },
      required: ['item', 'poStatus'],
    },
  },
];

/** Execute a tool call and return the result */
export async function executeTool(name: string, args: any): Promise<string> {
  switch (name) {
    case 'search_cars': {
      let cars = await getCars();

      if (args.brand) {
        const b = args.brand.toLowerCase();
        cars = cars.filter(c => c.brand.toLowerCase().includes(b));
      }
      if (args.status) cars = cars.filter(c => c.status === args.status);
      if (args.year) cars = cars.filter(c => c.year === args.year);
      if (args.model) {
        const m = args.model.toLowerCase();
        cars = cars.filter(c => c.model.toLowerCase().includes(m));
      }
      if (args.poStatus) cars = cars.filter(c => c.poStatus === args.poStatus);
      if (args.query) {
        const q = args.query.toLowerCase();
        cars = cars.filter(c =>
          c.item.toLowerCase().includes(q) ||
          c.brand.toLowerCase().includes(q) ||
          c.model.toLowerCase().includes(q) ||
          c.vin.toLowerCase().includes(q) ||
          c.note.toLowerCase().includes(q)
        );
      }

      if (cars.length === 0) return '沒有找到符合條件的車輛。';

      const summary = cars.slice(0, 20).map(formatCar).join('\n');
      const extra = cars.length > 20 ? `\n...還有 ${cars.length - 20} 台` : '';
      return `找到 ${cars.length} 台車：\n${summary}${extra}`;
    }

    case 'get_stats': {
      const stats = await getStats();
      let result = `庫存統計（共 ${stats.total} 台）：\n\n`;

      result += '【狀態分佈】\n';
      for (const [k, v] of Object.entries(stats.byStatus)) {
        result += `  ${k}: ${v} 台\n`;
      }

      result += '\n【品牌 TOP 10】\n';
      const brandEntries = Object.entries(stats.byBrand).sort((a, b) => b[1] - a[1]).slice(0, 10);
      for (const [k, v] of brandEntries) {
        result += `  ${k}: ${v} 台\n`;
      }

      result += '\n【來源分佈】\n';
      for (const [k, v] of Object.entries(stats.bySource)) {
        result += `  ${k}: ${v} 台\n`;
      }

      result += '\n【PO 狀態】\n';
      for (const [k, v] of Object.entries(stats.byPoStatus)) {
        result += `  ${k}: ${v} 台\n`;
      }

      return result;
    }

    case 'update_po': {
      if (!args.item || !args.poStatus) return '需要提供車輛編號和 PO 狀態。';
      const success = await setPoStatus(args.item, args.poStatus);
      return success
        ? `已更新 ${args.item} 的 PO 狀態為「${args.poStatus}」`
        : `找不到車輛 ${args.item}，請確認編號是否正確。`;
    }

    default:
      return `未知工具: ${name}`;
  }
}

function formatCar(car: CarRecord): string {
  return `- [${car.item}] ${car.year} ${car.brand} ${car.model} | ${car.status} | 外觀:${car.exteriorColor || '-'} 內裝:${car.interiorColor || '-'} | PO:${car.poStatus} | ${car.owner || '-'}`;
}
