-- 交付类型补分类 kind 与状态 status（K44 扩展）。
-- kind：咨询类/活动类/圈子类/其他类；status：有效/失效。老行默认 other + active。
ALTER TABLE delivery_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('consulting','activity','circle','other'));
ALTER TABLE delivery_types ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'));
