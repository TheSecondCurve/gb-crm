-- 2026-08 产品决策（K45–K48）：客户画像 v1 —— 标签词表 + 客户标签 M2M + LLM 打标配置 + customers.industry。
-- K45：tags 为可维护词表（身份/阶段/兴趣/其它，scope 枚举），软删；AI 打标只能从词表选词。
-- K46：ai_config 单行表（OpenAI 兼容接口：provider/base_url/api_key/model），apiKey 明文存库
--      （库文件 chmod 600 + 内网，at-rest 依赖 OS 文件权限，见 AGENTS.md）；API 响应永不全量返回。
-- K48：customers 扩展 industry（行业）一列，作为画像与 AI 打标输入。

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('identity','stage','interest','other')),
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER
);

-- name：live unique，软删后释放可复用（与 users.username 同规则）
CREATE UNIQUE INDEX tags_name_live_uq ON tags(name) WHERE deleted_at IS NULL;

-- 客户 ↔ 标签 M2M（K24 关系数组语义：缺席不动、[] 清空、[ids] 整表替换）。
-- 软删标签后 join 行保留、不展开（K9 类比）；标签定义软删不级联删 join。
CREATE TABLE customer_tags (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (customer_id, tag_id)
);

CREATE INDEX customer_tags_tag_id_idx ON customer_tags(tag_id);

CREATE TABLE ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT,
  base_url TEXT,
  api_key TEXT,
  model TEXT,
  updated_at INTEGER,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE customers ADD COLUMN industry TEXT;

-- 预置核心标签（系统种子，created_by = NULL；scope: 身份 / 阶段 / 兴趣）
INSERT INTO tags (name, scope, sort, enabled, created_at, updated_at) VALUES
  ('创业者',   'identity', 1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('职场人',   'identity', 2, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('自由职业者','identity', 3, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('企业主',   'identity', 4, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('线索',     'stage',    1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('已联系',   'stage',    2, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('咨询中',   'stage',    3, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('已成交',   'stage',    4, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('沉睡',     'stage',    5, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('商学院',   'interest', 1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('知识付费', 'interest', 2, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('商业咨询', 'interest', 3, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('圈子社群', 'interest', 4, 1, unixepoch() * 1000, unixepoch() * 1000);
