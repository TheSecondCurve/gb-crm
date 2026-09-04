-- 2026-09 产品决策（K57）：资料 kind 扩展 file（对象存储）+ 文件元数据列。
-- SQLite 无法 ALTER CHECK，重建 delivery_materials；先卸子表再重建父表，FTS 触发器一并重建。
-- 大文本 url/content 仍放表末，新增列在其前。

CREATE TABLE delivery_material_customers_k57 AS SELECT * FROM delivery_material_customers;
DROP TABLE delivery_material_customers;

DROP TRIGGER IF EXISTS delivery_materials_fts_ai;
DROP TRIGGER IF EXISTS delivery_materials_fts_au;

CREATE TABLE delivery_materials_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER REFERENCES deliveries(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER,
  object_key TEXT,                 -- kind=file 的远端对象 key
  content_type TEXT,               -- MIME
  file_size INTEGER,               -- 字节
  original_filename TEXT,          -- 上传时的原始文件名
  url TEXT,
  content TEXT,
  CHECK (kind IN ('transcript','text','audio','video','link','file'))
);

INSERT INTO delivery_materials_new (
  id, delivery_id, kind, title, created_at, updated_at, created_by, updated_by,
  deleted_at, url, content
)
SELECT
  id, delivery_id, kind, title, created_at, updated_at, created_by, updated_by,
  deleted_at, url, content
FROM delivery_materials;

DROP TABLE delivery_materials;
ALTER TABLE delivery_materials_new RENAME TO delivery_materials;

CREATE INDEX delivery_materials_delivery_idx ON delivery_materials(delivery_id);

CREATE TABLE delivery_material_customers (
  material_id INTEGER NOT NULL REFERENCES delivery_materials(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (material_id, customer_id)
);

INSERT INTO delivery_material_customers SELECT * FROM delivery_material_customers_k57;
DROP TABLE delivery_material_customers_k57;
CREATE INDEX delivery_material_customers_customer_idx ON delivery_material_customers(customer_id);

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
