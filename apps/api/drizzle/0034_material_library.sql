-- 2026-10 产品决策（K63）：素材库增强——文件夹树 + 描述 + 图片元信息 + checksum + AI 识别状态。
-- material_folders：自引用树（parent_id NULL = 根）；live 唯一「同级不重名」（NULL 视为 0 参与唯一，根下也不重名），
-- 跨级可重名；路径不落库，读取时递归推导（rename/移动零联动）。
-- delivery_materials 加列：description（文字描述，入 FTS）/ folder_id / image_width / image_height /
-- checksum（sha256 hex，查重与完整性）/ ai_status（vision LLM 识别状态）/ enriched_at。
-- FTS 重建：title + description + content（触发器同步 + 存量回填）。

CREATE TABLE material_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES material_folders(id) ON DELETE SET NULL,  -- NULL = 根
  name TEXT NOT NULL,                     -- 1..100 字，不含 '/'
  created_at INTEGER NOT NULL,            -- epoch ms UTC
  updated_at INTEGER NOT NULL,            -- epoch ms UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER                      -- 软删（epoch ms UTC）
);

CREATE UNIQUE INDEX material_folders_parent_name_live_idx
  ON material_folders(coalesce(parent_id, 0), name) WHERE deleted_at IS NULL;
CREATE INDEX material_folders_parent_idx ON material_folders(parent_id);

ALTER TABLE delivery_materials ADD COLUMN description TEXT;
ALTER TABLE delivery_materials ADD COLUMN folder_id INTEGER REFERENCES material_folders(id) ON DELETE SET NULL;
ALTER TABLE delivery_materials ADD COLUMN image_width INTEGER;
ALTER TABLE delivery_materials ADD COLUMN image_height INTEGER;
ALTER TABLE delivery_materials ADD COLUMN checksum TEXT;
ALTER TABLE delivery_materials ADD COLUMN ai_status TEXT
  CHECK (ai_status IN ('pending','ready','failed','skipped'));
ALTER TABLE delivery_materials ADD COLUMN enriched_at INTEGER;

CREATE INDEX delivery_materials_folder_idx ON delivery_materials(folder_id);
CREATE INDEX delivery_materials_checksum_idx ON delivery_materials(checksum);

-- FTS 重建（列扩为 title/description/content）：旧触发器与虚表先删后建，存量 live 行回填。
DROP TRIGGER delivery_materials_fts_ai;
DROP TRIGGER delivery_materials_fts_au;
DROP TABLE delivery_materials_fts;

CREATE VIRTUAL TABLE delivery_materials_fts USING fts5(title, description, content, tokenize='trigram');

CREATE TRIGGER delivery_materials_fts_ai AFTER INSERT ON delivery_materials
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO delivery_materials_fts(rowid, title, description, content)
  VALUES (new.id, new.title, coalesce(new.description, ''), coalesce(new.content, ''));
END;

CREATE TRIGGER delivery_materials_fts_au AFTER UPDATE ON delivery_materials
BEGIN
  DELETE FROM delivery_materials_fts WHERE rowid = old.id;
  INSERT INTO delivery_materials_fts(rowid, title, description, content)
  SELECT new.id, new.title, coalesce(new.description, ''), coalesce(new.content, '')
  WHERE new.deleted_at IS NULL;
END;

INSERT INTO delivery_materials_fts(rowid, title, description, content)
SELECT id, title, coalesce(description, ''), coalesce(content, '')
FROM delivery_materials WHERE deleted_at IS NULL;
