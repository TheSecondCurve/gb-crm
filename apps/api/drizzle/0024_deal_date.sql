-- 成交表新增「成交日期」deal_date（epoch ms，NOT NULL；与交付日期 delivery_date 并存、语义不同）。
-- 回填：历史交付日期现值搬入成交日期（交付日期可空，空值兜底创建时间），完成后交付日期列置空保留。
ALTER TABLE deals ADD COLUMN deal_date INTEGER NOT NULL DEFAULT 0;
UPDATE deals SET deal_date = COALESCE(delivery_date, created_at);
UPDATE deals SET delivery_date = NULL;
