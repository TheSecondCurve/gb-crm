-- 交付单补名称（可空；老行自动为 NULL）。
ALTER TABLE deliveries ADD COLUMN name TEXT;
