-- 2026-09 产品决策（成交分成 v2）：三级分红（税后基数 → 总比例 → 内部分配）+ payout。
-- 总比例存 deals.commission_ratio（可空，逐成交覆盖），回退 products.commission_ratio → commissionDefault.totalRatio。
-- deal_commission_items.percentage 语义从 base-relative 改为 pool-relative（占分红池的内部分配，Σ≤1）。
-- 语义改变：清除既有自定义配置，让所有成交回退到新默认方案。
-- payout：每笔成交最多 2 个支付期（seq 1|2），手工维护 date+rate，金额=round(分红池×rate)，状态 pending|paid。

ALTER TABLE products ADD COLUMN commission_ratio REAL
  CHECK (commission_ratio IS NULL OR (commission_ratio >= 0 AND commission_ratio <= 1));

ALTER TABLE deals ADD COLUMN commission_ratio REAL
  CHECK (commission_ratio IS NULL OR (commission_ratio >= 0 AND commission_ratio <= 1));

CREATE TABLE deal_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL REFERENCES deals(id),
  seq INTEGER NOT NULL,                    -- 1 | 2
  payout_date INTEGER NOT NULL,            -- epoch ms UTC（支付期）
  rate REAL NOT NULL CHECK (rate >= 0 AND rate <= 1),  -- 占分红池比例（0~1）
  amount_cents INTEGER NOT NULL,           -- round(分红池 × rate)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (deal_id, seq)
);

CREATE INDEX deal_payouts_deal_id_idx ON deal_payouts(deal_id);

-- 语义改变：清除既有自定义分成配置，全部回退到默认方案
DELETE FROM deal_commission_items;
DELETE FROM deal_commissions;
