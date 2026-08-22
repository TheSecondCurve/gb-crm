-- 2026-08 产品决策（K43）：交付项 + 动作打勾清单（对照飞书「用户权益明细表」= 交付项）。
-- 交付项挂成交（一个成交可拆多条）；动作清单为交付项子表（硬删，无 deleted_at，同 customer_social_accounts）。
-- 产品目录加 default_tasks 多行文本作「默认交付动作」模板：新建交付项时复制为初始清单，之后独立（不实时同步）。

ALTER TABLE products ADD COLUMN default_tasks TEXT;

CREATE TABLE deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','delivering','delivered','cancelled')),
  plan_deliver_date INTEGER,      -- epoch ms UTC，可空
  actual_deliver_date INTEGER,    -- epoch ms UTC，可空
  expiry_date INTEGER,            -- epoch ms UTC，可空
  description TEXT,
  delivery_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER
);

CREATE INDEX deliverables_deal_id_idx ON deliverables(deal_id);
CREATE INDEX deliverables_product_id_idx ON deliverables(product_id);
CREATE INDEX deliverables_status_idx ON deliverables(status);

CREATE TABLE delivery_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_id INTEGER NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,                -- epoch ms UTC，可空（done 翻转时服务端写/清）
  done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX delivery_tasks_deliverable_id_idx ON delivery_tasks(deliverable_id);
