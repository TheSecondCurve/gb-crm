-- 2026-09 产品决策（K59）：Payout 结算批次（分成发放）。
-- payout_batches：按 payout 日期范围归集待发 payout 的批次（状态机 draft→locked→paid，locked 可 unlock 回 draft）。
-- payout_batch_items：按 (deal_id, seq) 引用 deal_payouts（不引用 payout 行 id——PUT payouts 整表替换会换行 id）；
--   锁定时快照 amount_cents/payout_date/rate，draft 为 NULL（展示走实时计算）。
-- payout_batch_item_shares：锁定时按 shared splitPayoutAmount 物化的人均分摊快照（财务查账基准）；unlock 清空。

CREATE TABLE payout_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  range_start INTEGER NOT NULL,            -- epoch ms UTC，创建时筛选口径（展示/查账用）
  range_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','paid')),
  locked_at INTEGER,
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE payout_batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  seq INTEGER NOT NULL,                    -- 与 deal_payouts 对齐，1 | 2
  -- 锁定时快照（draft 为 NULL，展示走实时计算）：
  amount_cents INTEGER,
  payout_date INTEGER,
  rate REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (batch_id, deal_id, seq)
);

CREATE INDEX payout_batch_items_deal_seq_idx ON payout_batch_items(deal_id, seq);

-- 锁定时物化的人均分摊快照（查账基准）
CREATE TABLE payout_batch_item_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES payout_batch_items(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  UNIQUE (item_id, user_id)
);

CREATE INDEX payout_batch_item_shares_item_idx ON payout_batch_item_shares(item_id);
