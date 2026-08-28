-- 2026-08 产品决策（K54）：交付资料（咨询语料/文本/音视频链接）。
-- 每一场咨询 = 一条 deliveries（无父子记录）；资料挂交付单（可空，允许孤儿导入）+ 客户 M2M（0..N）。
-- 文本类（transcript/text）全文入 content；媒体类（audio/video/link）只存 url + title 说明（Zod 校验必填）。
-- content/url 放表末尾：大文本走 overflow page，查询不引用时惰性读。
-- FTS5（trigram 分词，中文子串 ≥3 字符）索引 title+content，触发器同步；软删即移出索引。

CREATE TABLE delivery_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER REFERENCES deliveries(id) ON DELETE SET NULL,  -- 可空：孤儿资料
  kind TEXT NOT NULL,                     -- transcript/text/audio/video/link
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,            -- epoch ms UTC
  updated_at INTEGER NOT NULL,            -- epoch ms UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER,                     -- 软删（epoch ms UTC）
  url TEXT,                               -- 媒体类必填（Zod 层校验）
  content TEXT,                           -- 文本类全文（Zod 层校验）
  CHECK (kind IN ('transcript','text','audio','video','link'))
);

CREATE TABLE delivery_material_customers (
  material_id INTEGER NOT NULL REFERENCES delivery_materials(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (material_id, customer_id)
);

CREATE INDEX delivery_materials_delivery_idx ON delivery_materials(delivery_id);
CREATE INDEX delivery_material_customers_customer_idx ON delivery_material_customers(customer_id);

CREATE VIRTUAL TABLE delivery_materials_fts USING fts5(title, content, tokenize='trigram');

CREATE TRIGGER delivery_materials_fts_ai AFTER INSERT ON delivery_materials
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO delivery_materials_fts(rowid, title, content)
  VALUES (new.id, new.title, coalesce(new.content, ''));
END;

CREATE TRIGGER delivery_materials_fts_au AFTER UPDATE ON delivery_materials
BEGIN
  DELETE FROM delivery_materials_fts WHERE rowid = old.id;
  INSERT INTO delivery_materials_fts(rowid, title, content)
  SELECT new.id, new.title, coalesce(new.content, '')
  WHERE new.deleted_at IS NULL;
END;
