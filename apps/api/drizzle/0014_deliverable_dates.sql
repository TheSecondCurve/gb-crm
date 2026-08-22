-- 交付项补开始/结束时间（epoch 毫秒，日历输入；可空，老行自动为 NULL）。
-- 甘特图（项目维度）与状态矩阵（客户维度）为前端透视，无需新增列以外的结构。
ALTER TABLE deliverables ADD COLUMN starts_at INTEGER;
ALTER TABLE deliverables ADD COLUMN ends_at INTEGER;
