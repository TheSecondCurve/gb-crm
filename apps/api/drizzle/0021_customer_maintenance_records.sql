-- 2026-08 产品决策（K55）：客户维护记录（时序时间线）。
-- 销售为每个客户随手记录跟进触点（沟通/状态变化/线索/备注），按时间倒序持续积累，
-- 补足「结构化业务事件（成交/交付/资料）」之外的客户侧自由书写日志。
-- 纯时间线表达客户状态（不新增 customers.status 列）；happened_at 与 created_at 分离（支持补录）。
-- 软删（deleted_at）；kind 枚举用 CHECK 限定；无 FTS / 无 M2M / 无多态关联。

CREATE TABLE customer_maintenance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL,                     -- follow_up/status_change/lead/note/other
  happened_at INTEGER NOT NULL,           -- 记录对应的时间点（可回填），epoch ms UTC
  content TEXT,                           -- 记了什么（自由文本）
  created_at INTEGER NOT NULL,            -- epoch ms UTC
  updated_at INTEGER NOT NULL,            -- epoch ms UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER,                     -- 软删（epoch ms UTC）
  CHECK (kind IN ('follow_up','status_change','lead','note','other'))
);

CREATE INDEX customer_maintenance_records_customer_idx ON customer_maintenance_records(customer_id);
