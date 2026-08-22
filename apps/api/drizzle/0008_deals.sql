-- 2026-08 产品决策（K42）：内部成交表 v1 化（对照飞书「团队核心数据库 → 成交表」）。
-- 字段裁剪：客户/意向产品/负责人单值 FK；去成交人、财务类（税后系数/提现基数/奖金系数/
-- 金额/成交人比例/各类奖金/奖金核算记录）、是否进群/是否发货。软删语义同其它表。
CREATE TABLE deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'gift' CHECK (stage IN ('gift','paid','refunded','closed')),
  order_no TEXT,
  payment_remark TEXT,
  delivery_date INTEGER,             -- epoch ms UTC，可空
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER
);

CREATE INDEX deals_customer_id_idx ON deals(customer_id);
CREATE INDEX deals_product_id_idx ON deals(product_id);
CREATE INDEX deals_owner_id_idx ON deals(owner_id);
CREATE INDEX deals_stage_idx ON deals(stage);
