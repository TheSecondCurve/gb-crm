-- 2026-09 产品决策（K58）：资料标签。
-- tags 加 domain（customer|material），live unique 改为 (domain, name)；
-- 老行默认 customer。资料挂接走独立 M2M delivery_material_tags（硬删，同 customer_tags）。

ALTER TABLE tags ADD COLUMN domain TEXT NOT NULL DEFAULT 'customer'
  CHECK (domain IN ('customer','material'));

DROP INDEX tags_name_live_uq;
CREATE UNIQUE INDEX tags_domain_name_live_uq ON tags(domain, name) WHERE deleted_at IS NULL;

CREATE TABLE delivery_material_tags (
  material_id INTEGER NOT NULL REFERENCES delivery_materials(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (material_id, tag_id)
);

CREATE INDEX delivery_material_tags_tag_id_idx ON delivery_material_tags(tag_id);
