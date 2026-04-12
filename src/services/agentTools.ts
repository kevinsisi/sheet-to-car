import { SchemaType, FunctionDeclaration } from '@google/generative-ai';
import { clearOwnerOverride, getCars, getStats, setOwnerOverride, setPoStatus, syncFromSheet } from './carInventory';
import { generateAllCopies, generateCopyWithMeta, getCopies, resolveOwner, setUserPreference, PLATFORMS } from './copyGenerator';
import { CarRecord } from '../lib/sheets/types';
import { loadPlatformPrompt, savePlatformPrompt, resetPlatformPrompt } from '../prompts/promptLoader';
import { getLatestPhotoAnalysis, getVehicleAnalysis } from './vehicleAnalysis';
import db from '../db/connection';

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
  {
    name: 'generate_copy',
    description: '為車輛生成文案。可指定平台（官網、8891、Facebook）或全部生成',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        item: { type: SchemaType.STRING, description: '車輛編號' },
        platform: { type: SchemaType.STRING, description: '平台：官網、Facebook、8891。不填則全部生成' },
      },
      required: ['item'],
    },
  },
  {
    name: 'remember_preference',
    description: '記住使用者的偏好設定，例如語氣、風格、自訂規則。下次生成文案時會自動套用',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        key: { type: SchemaType.STRING, description: '偏好類型：tone（語氣）、style（風格）、custom_rules（自訂規則）' },
        value: { type: SchemaType.STRING, description: '偏好內容' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'update_platform_prompt',
    description: '查看或修改平台文案規範（Prompt）。可查看目前內容、套用使用者要求的修改、或重置為預設值。支援平台：官網、Facebook、8891',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        platform: { type: SchemaType.STRING, description: '平台名稱：官網、Facebook、8891' },
        action: { type: SchemaType.STRING, description: '動作：view（查看）、update（更新，需提供 content）、reset（重置為預設）' },
        content: { type: SchemaType.STRING, description: 'action 為 update 時，完整的新 prompt 內容' },
      },
      required: ['platform', 'action'],
    },
  },
  {
    name: 'sync_sheet',
    description: '立即重新同步 Google Sheets 車輛資料，當 owner、狀態或最新車輛資料可能過期時可使用',
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: 'get_generation_readiness',
    description: '檢查某台車目前是否適合生成文案，列出 owner、待確認欄位、照片分析、8891 blockers 等阻擋因素',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        item: { type: SchemaType.STRING, description: '車輛編號' },
      },
      required: ['item'],
    },
  },
  {
    name: 'resolve_owner',
    description: '查看或處理 owner 對應。可檢查目前 owner 狀態、設定 owner override、或清除 override 改回同步 owner',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        item: { type: SchemaType.STRING, description: '車輛編號' },
        action: { type: SchemaType.STRING, description: '動作：check（檢查）、set_override（指定 owner）、clear_override（清除 override）' },
        owner: { type: SchemaType.STRING, description: 'action 為 set_override 時，指定的 english_name' },
      },
      required: ['item', 'action'],
    },
  },
  {
    name: 'inspect_copy_output',
    description: '檢查某台車最新文案的實際輸出內容，可用來確認 8891 / 官網 / Facebook 結構、top-level keys、是否含 metadata、驗證狀態等',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        item: { type: SchemaType.STRING, description: '車輛編號' },
        platform: { type: SchemaType.STRING, description: '平台：官網、Facebook、8891' },
      },
      required: ['item', 'platform'],
    },
  },
];

function formatOwnerResolutionGuidance(item: string, ownerValue: string, resolution: ReturnType<typeof resolveOwner>): string {
  let result = `【${item} 無法直接生成文案】\n`;
  result += `目前 owner：${ownerValue || '(空白)'}\n`;
  result += `owner 狀態：${resolution.status}`;

  if (resolution.matches.length > 0) {
    result += `\n匹配：${resolution.matches.map(match => `${match.english_name}/${match.name}`).join('、')}`;
  }

  result += '\n\n建議下一步：';
  result += '\n1. 先用 get_generation_readiness 檢查整體阻擋因素';
  result += '\n2. 用 resolve_owner 的 check 查看 owner 狀態';
  result += '\n3. 若資料可能已過期，先執行 sync_sheet';
  result += '\n4. 若仍無法唯一匹配，再用 resolve_owner 的 set_override 指定正確 english_name';
  return result;
}

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

    case 'generate_copy': {
      if (!args.item) return '需要提供車輛編號。';
      const allCars = await getCars();
      const car = allCars.find(c => c.item === args.item);
      if (!car) return `找不到車輛 ${args.item}`;

      const ownerResolution = resolveOwner(car.owner);
      if (ownerResolution.status !== 'resolved') {
        return formatOwnerResolutionGuidance(car.item, car.owner, ownerResolution);
      }

      if (args.platform) {
        const generated = await generateCopyWithMeta(car, args.platform);
        let reply = `已生成 ${args.platform} 文案：\n\n${generated.content}`;
        if (generated.reviewHints.length > 0) {
          reply += '\n\n【建議人工確認】\n';
          reply += generated.reviewHints.map(hint => `- ${hint.field}: ${hint.reason}`).join('\n');
        }
        return reply;
      } else {
        const generated = await generateAllCopies(car);
        let reply = '已生成全部平台文案：\n';
        for (const [platform, content] of Object.entries(generated.results)) {
          reply += `\n【${platform}】\n${content}\n`;
        }
        if (Object.keys(generated.errors).length > 0) {
          reply += '\n【失敗平台】\n';
          for (const [platform, error] of Object.entries(generated.errors)) {
            reply += `- ${platform}: ${error}\n`;
          }
        }
        return reply;
      }
    }

    case 'update_platform_prompt': {
      const { platform, action, content } = args;
      if (!platform || !PLATFORMS.includes(platform)) {
        return `平台名稱無效，支援：${PLATFORMS.join('、')}`;
      }
      if (action === 'view') {
        const current = loadPlatformPrompt(platform);
        return `【${platform} 目前 Prompt】\n\n${current}`;
      } else if (action === 'update') {
        if (!content || typeof content !== 'string') return '需要提供新的 prompt 內容（content）';
        savePlatformPrompt(platform, content);
        return `已更新【${platform}】Prompt。下次生成文案時生效。`;
      } else if (action === 'reset') {
        resetPlatformPrompt(platform);
        const restored = loadPlatformPrompt(platform);
        return `已重置【${platform}】Prompt 為預設值。\n\n${restored}`;
      }
      return 'action 必須是 view、update 或 reset';
    }

    case 'sync_sheet': {
      const count = await syncFromSheet();
      return `已重新同步 Google Sheets，現有 ${count} 台車。`;
    }

    case 'get_generation_readiness': {
      if (!args.item) return '需要提供車輛編號。';
      const allCars = await getCars();
      const car = allCars.find(c => c.item === args.item);
      if (!car) return `找不到車輛 ${args.item}`;

      const owner = resolveOwner(car.owner);
      const analysis = getVehicleAnalysis(car.item);
      const photo = getLatestPhotoAnalysis(car.item);
      const copies = getCopies(car.item);
      const postHelper = copies.find(copy => copy.platform === '8891');
      const analysisReady = Boolean(analysis && analysis.status !== 'pending');
      const photoReady = Boolean(photo);
      const analysisState = analysis ? analysis.status : 'missing';

      let result = `【${car.item} 生成前檢查】\n`;
      result += `車輛：${car.year} ${car.brand} ${car.model}\n`;
      result += `目前 owner：${car.owner || '(空白)'}\n`;
      result += `owner 狀態：${owner.status}\n`;
      if (owner.matches.length > 0) {
        result += `匹配結果：${owner.matches.map(match => `${match.english_name}/${match.name}`).join('、')}\n`;
      }
      result += `基礎分析待確認：${analysis?.reviewHints.length || 0} 項\n`;
      result += `照片分析待確認：${photo?.reviewHints.length || 0} 項\n`;
      result += `照片建議描述：${photo?.suggestedCopyLines.length || 0} 項\n`;
      result += `基礎分析：${analysisState === 'missing' ? '尚未建立' : analysisState}\n`;
      result += `照片分析：${photoReady ? '已有資料' : '尚未分析'}\n`;
      if (postHelper) {
        result += `8891 驗證：${postHelper.validation_status}（error=${postHelper.validation_error_count}, warning=${postHelper.validation_warning_count}）\n`;
      }

      if (owner.status !== 'resolved') {
        result += '\n建議：先同步資料；若仍無法唯一匹配，再指定 owner override。';
      } else if (!analysisReady) {
        result += '\n建議：先跑基礎分析，再生成文案。';
      } else if (postHelper?.validation_status === 'error') {
        result += '\n建議：先修正 8891 阻塞問題，再視需要重新生成。';
      } else if ((analysis?.reviewHints.length || 0) > 0 || (photo?.reviewHints.length || 0) > 0) {
        result += '\n建議：可先生成，但要留意仍有待確認欄位。';
      } else {
        result += '\n目前可直接生成。';
      }
      return result;
    }

    case 'resolve_owner': {
      if (!args.item || !args.action) return '需要提供 item 與 action。';
      const allCars = await getCars();
      const car = allCars.find(c => c.item === args.item);
      if (!car) return `找不到車輛 ${args.item}`;

      if (args.action === 'check') {
        const resolution = resolveOwner(car.owner);
        let result = `【${car.item} owner 檢查】\n目前 owner：${car.owner || '(空白)'}\n狀態：${resolution.status}`;
        if (resolution.matches.length > 0) {
          result += `\n匹配：${resolution.matches.map(match => `${match.english_name}/${match.name}`).join('、')}`;
        }
        if (resolution.status !== 'resolved') {
          result += '\n可先用 sync_sheet 更新資料，必要時再用 set_override 指定 owner。';
        }
        return result;
      }

      if (args.action === 'set_override') {
        if (!args.owner) return 'set_override 需要提供 owner（english_name）。';
        const validOwner = db.prepare('SELECT name, english_name FROM team_members WHERE is_active = 1 AND english_name = ?').get(String(args.owner).trim()) as any;
        if (!validOwner) {
          return `owner 無效。請使用有效 english_name。`;
        }
        const success = setOwnerOverride(args.item, args.owner);
        return success
          ? `已為 ${args.item} 指定 owner override = ${args.owner}`
          : `無法為 ${args.item} 設定 owner override`;
      }

      if (args.action === 'clear_override') {
        const success = clearOwnerOverride(args.item);
        return success
          ? `已清除 ${args.item} 的 owner override，改回使用同步 owner。`
          : `${args.item} 目前沒有 owner override。`;
      }

      return 'action 必須是 check、set_override 或 clear_override';
    }

    case 'inspect_copy_output': {
      if (!args.item || !args.platform) return '需要提供 item 與 platform。';
      if (!PLATFORMS.includes(args.platform)) return `平台名稱無效，支援：${PLATFORMS.join('、')}`;

      const copies = getCopies(args.item).filter(copy => copy.platform === args.platform);
      if (copies.length === 0) {
        return `${args.item} 目前沒有 ${args.platform} 文案。`;
      }

      const latest = copies[0];
      let result = `【${args.item} ${args.platform} 最新文案檢查】\n`;
      result += `版本：#${latest.id}\n`;
      result += `狀態：${latest.status}\n`;
      result += `建立時間：${latest.created_at}\n`;

      if (args.platform !== '8891') {
        result += '此平台不是 JSON contract 平台，請直接查看文案內容。';
        return result;
      }

      try {
        const parsed = JSON.parse(latest.content);
        const topLevelKeys = Object.keys(parsed).sort();
        const exactCoreKeys = ['basic', 'contact', 'listing', 'specs'];
        const hasMetadata = Object.prototype.hasOwnProperty.call(parsed, 'metadata');
        const topKeysMatch = JSON.stringify(topLevelKeys) === JSON.stringify(exactCoreKeys);

        result += `top-level keys：${topLevelKeys.join(', ')}\n`;
        result += `含 metadata：${hasMetadata ? '是' : '否'}\n`;
        result += `結構符合 8891 prompt contract：${topKeysMatch && !hasMetadata ? '是' : '否'}\n`;
        result += `post-helper 驗證：${latest.validation_status}（error=${latest.validation_error_count}, warning=${latest.validation_warning_count}）`;
        return result;
      } catch {
        return `${result}內容不是合法 JSON，無法檢查 contract。`;
      }
    }

    case 'remember_preference': {
      if (!args.key || !args.value) return '需要提供偏好類型和內容。';
      setUserPreference(args.key, args.value);
      return `已記住偏好：${args.key} = ${args.value}`;
    }

    default:
      return `未知工具: ${name}`;
  }
}

function formatCar(car: CarRecord): string {
  return `- [${car.item}] ${car.year} ${car.brand} ${car.model} | ${car.status} | 外觀:${car.exteriorColor || '-'} 內裝:${car.interiorColor || '-'} | PO:${car.poStatus} | ${car.owner || '-'}`;
}
