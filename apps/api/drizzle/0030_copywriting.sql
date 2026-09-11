-- 2026-09 产品决策（K60）：文案工作台（私域运营分组）。
-- copy_templates：六维度提示词模板词表（业务背景/目标客群/主题内容/预期目的/产出类型/润色要求），
-- live 唯一按 (dimension, name)；软删。
-- copy_items：已保存文案，六段维度存**文本快照**（模板改动不影响历史），audit_report 存审计 JSON 快照；软删。

CREATE TABLE copy_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dimension TEXT NOT NULL,                -- background/audience/topic/goal/outputType/polish
  name TEXT NOT NULL,                     -- 模板名（≤50）
  content TEXT NOT NULL,                  -- 提示词正文
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,     -- 1 启用 / 0 停用
  created_at INTEGER NOT NULL,            -- epoch ms UTC
  updated_at INTEGER NOT NULL,            -- epoch ms UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER,                     -- 软删（epoch ms UTC）
  CHECK (dimension IN ('background','audience','topic','goal','outputType','polish'))
);

-- live 唯一：同维度同名仅一条未删除（仿 tags K45）
CREATE UNIQUE INDEX copy_templates_live_unique
  ON copy_templates(dimension, name) WHERE deleted_at IS NULL;

CREATE TABLE copy_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                    -- 文案标题（≤100）
  background TEXT,                        -- 六段维度文本快照（可空）
  audience TEXT,
  topic TEXT,
  goal TEXT,
  output_type TEXT,
  polish TEXT,
  content TEXT NOT NULL,                  -- 文案正文
  audit_report TEXT,                      -- 审计报告 JSON 快照（CopyAuditReport），未审计算 NULL
  created_at INTEGER NOT NULL,            -- epoch ms UTC
  updated_at INTEGER NOT NULL,            -- epoch ms UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER                      -- 软删（epoch ms UTC）
);

CREATE INDEX copy_items_updated_idx ON copy_items(updated_at);
