CREATE TABLE IF NOT EXISTS cars (
  item TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  manufacture_date TEXT NOT NULL DEFAULT '',
  mileage TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  exterior_color TEXT NOT NULL DEFAULT '',
  interior_color TEXT NOT NULL DEFAULT '',
  modification TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  po_status TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  bg_color TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cars_item_desc ON cars(item DESC);
CREATE INDEX IF NOT EXISTS idx_cars_status ON cars(status);
CREATE INDEX IF NOT EXISTS idx_cars_brand ON cars(brand);
CREATE INDEX IF NOT EXISTS idx_cars_po_status ON cars(po_status);
