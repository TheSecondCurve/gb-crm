-- 2026-08 产品决策（K56）：成交分成（销售团队财务）。
-- 以「成交」为粒度一张分成配置表（deal_commissions，deal_id 唯一、懒生成——只有被配置过的成交才有行，
-- 未配置的成交通过 LEFT JOIN NULL 判定并在读取时动态套用全局默认方案）；
-- 每个成交人一行明细（deal_commission_items，一成交一行、一人一行）。软校验：同一份明细比例总和 ≤ 1。
-- 分成金额 = amount_cents × after_tax_ratio（税后基数）× percentage。

CREATE TABLE deal_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL UNIQUE REFERENCES deals(id),
  configured_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  configured_at INTEGER,                 -- 最近一次配置时间（epoch ms UTC）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE deal_commission_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_commission_id INTEGER NOT NULL REFERENCES deal_commissions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  percentage REAL NOT NULL,              -- 占税后基数的比例（0~1）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX deal_commission_items_commission_idx ON deal_commission_items(deal_commission_id);
