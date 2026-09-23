-- 2026-09 产品决策（K62）：客户全景驾驶舱 —— 信号层三张表。
-- customers 主表零改动；本迁移只做增量。
--  1) signal_topics           归一主题词表（种子由抽取任务运行时从兴趣标签/产品/行业预热）
--  2) signal_topic_relations  词表图谱：related 边（LLM 建新词必须带 nearest；admin 手工关联/合并）
--  3) customer_signals        客户信号（LLM 抽取 + 人工补录；无独立 status 列——
--     状态是推导值：rejected_by 非空 = 已否决；superseded_by 非空 = 已被取代；
--     有效 = 未软删 ∧ 未否决 ∧ 未取代 ∧ (expires_at 为空 或 > now)，TTL 按 type 见 shared/insights.ts）

CREATE TABLE signal_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                       -- 归一主题词（如「小红书运营」）
  enabled INTEGER NOT NULL DEFAULT 1,       -- 0 = 停用（不再参与归一/撮合）
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,              -- epoch ms UTC
  updated_at INTEGER NOT NULL,              -- epoch ms UTC
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER                        -- 软删（合并词 = 软删 + 信号改指）
);
-- live 唯一（软删后释放名字）
CREATE UNIQUE INDEX signal_topics_name_live_uq ON signal_topics(name) WHERE deleted_at IS NULL;

CREATE TABLE signal_topic_relations (
  topic_id INTEGER NOT NULL REFERENCES signal_topics(id),
  related_topic_id INTEGER NOT NULL REFERENCES signal_topics(id),
  source TEXT NOT NULL,                     -- llm（建词自带 nearest）/ admin（手工关联）
  created_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (topic_id, related_topic_id),
  CHECK (source IN ('llm','admin')),
  CHECK (topic_id <> related_topic_id)
);

CREATE TABLE customer_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,                       -- growth/risk/intent/interest_hint/need/supply/lifecycle/sentiment
  topic_id INTEGER REFERENCES signal_topics(id),
  content TEXT NOT NULL,                    -- 一句话事实摘要
  source_type TEXT NOT NULL,                -- maintenance_record/origin_story/note/transcript/manual
  source_id INTEGER,                        -- 出处行 id（origin_story/note/manual 为 NULL）
  source_at INTEGER NOT NULL,               -- 原文发生时间（epoch ms；人工补录缺省 = 现在）
  mention_count INTEGER NOT NULL DEFAULT 1, -- 同义事实被提及次数（合并累加，反复出现 = 更可信）
  confidence REAL NOT NULL DEFAULT 1.0,     -- LLM 置信度 0-1；人工补录 = 1
  superseded_by INTEGER REFERENCES customer_signals(id),
  rejected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rejected_at INTEGER,
  expires_at INTEGER,                       -- 按 type TTL 写入时推导（NULL = 不过期，只被取代）
  prompt_version TEXT NOT NULL,             -- 抽取时的 prompt 版本（manual 固定 'manual'）
  extracted_at INTEGER NOT NULL,            -- 抽取/录入时间
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at INTEGER,
  CHECK (type IN ('growth','risk','intent','interest_hint','need','supply','lifecycle','sentiment')),
  CHECK (source_type IN ('maintenance_record','origin_story','note','transcript','manual')),
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX customer_signals_customer_idx ON customer_signals(customer_id, type);
CREATE INDEX customer_signals_topic_idx ON customer_signals(topic_id);
CREATE INDEX customer_signals_source_idx ON customer_signals(source_type, source_id);
CREATE INDEX customer_signals_expires_idx ON customer_signals(expires_at);
