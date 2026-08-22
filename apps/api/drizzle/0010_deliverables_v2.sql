-- 2026-08 产品决策（K44）：交付重构 —— 弱关联交付单 + 交付类型配置表 + 客户维度打勾。
-- 旧 K43 模型（deliverables 挂 deal，产品 default_tasks 模板）作废：dev 库与 e2e 均无真实数据，直接 DROP 重建。
-- 交付与成交弱关联：交付单独立存在，客户来源可来自成交 merge（前端交互，不持久化关联）。
-- 模板归交付类型管：products.default_tasks 列移除。

CREATE TABLE delivery_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  default_tasks TEXT,              -- 默认动作模板：多行文本，每行一个动作
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER
);

CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_type_id INTEGER NOT NULL REFERENCES delivery_types(id),
  remark TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER
);

CREATE INDEX deliveries_type_idx ON deliveries(delivery_type_id);

CREATE TABLE delivery_customers (
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (delivery_id, customer_id)
);

CREATE INDEX delivery_customers_customer_idx ON delivery_customers(customer_id);

-- 交付项（挂交付单；双维度；无独立状态，打勾进度即状态）
DROP TABLE delivery_tasks;
DROP TABLE deliverables;
CREATE TABLE deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  content TEXT NOT NULL,           -- 交付项标题（如 拉群 / 圈子全年交付）
  dimension TEXT NOT NULL DEFAULT 'project'
    CHECK (dimension IN ('project','customer')),
  description TEXT,
  delivery_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER
);

CREATE INDEX deliverables_delivery_idx ON deliverables(delivery_id);

-- 动作清单：客户维度任务按 customer_id 展开（每客户分别打勾/备注）；NULL = 项目维度
CREATE TABLE delivery_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  remark TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX delivery_tasks_deliverable_idx ON delivery_tasks(deliverable_id);
CREATE INDEX delivery_tasks_customer_idx ON delivery_tasks(customer_id);

-- 模板归交付类型管，移除产品列
ALTER TABLE products DROP COLUMN default_tasks;
