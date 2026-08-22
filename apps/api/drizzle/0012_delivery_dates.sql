-- 交付单补开始/结束日期（epoch 毫秒，本地时区当天零点；可空，老行自动为 NULL）。
ALTER TABLE deliveries ADD COLUMN starts_at INTEGER;
ALTER TABLE deliveries ADD COLUMN ends_at INTEGER;
