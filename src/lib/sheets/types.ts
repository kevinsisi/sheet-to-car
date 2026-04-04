export interface CarRecord {
  item: string;
  source: string;
  brand: string;
  year: string;
  manufactureDate: string;
  mileage: string;
  model: string;
  vin: string;
  condition: string;
  status: string;
  exteriorColor: string;
  interiorColor: string;
  modification: string;
  note: string;
  poStatus: string;
  poOfficial: boolean;
  po8891: boolean;
  poFacebook: boolean;
  poPostHelper: boolean;
  owner: string;
  price: string;
  bgColor: string;
}

export const CAR_HEADERS = [
  'item', '來源', 'Brand', '年式', '出廠年月', '里程', 'Model', '引擎碼(VIN)',
  '車況', '狀態', '外觀色', '內裝色', '改裝', 'PO狀態', '負責人', '開價', '備註'
];

export const STATUS_VALUES = ['在庫', '新到貨', '海運中', '驗車中', '已售出', '特殊'] as const;
export const PO_STATUS_VALUES = ['未PO', '部分PO', '已PO', '不需PO'] as const;
export const SOURCE_VALUES = ['國外進口', '台灣車', '託售', '寄賣'] as const;
export const CONDITION_VALUES = ['6/A', '5/A', '5/B', '4.5/A', '4.5/B', '4/A', '4/B', '4/C'] as const;

export type CarStatus = typeof STATUS_VALUES[number];
export type PoStatus = typeof PO_STATUS_VALUES[number];
