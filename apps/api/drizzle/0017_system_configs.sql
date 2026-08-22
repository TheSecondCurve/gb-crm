-- 2026-08 产品决策（K50）：统一系统配置表。ai_config 单行表 → system_configs（code 区分），
-- LLM 打标配置存 code='llm'（value 为 JSON 字符串）；未来新配置直接加 code 行，不再新建表。
-- 标签词表 tags 保持关系型业务表（customer_tags M2M 外键引用 tags.id，需每行审计/软删/live-unique），
-- 不进 KV 配置表；维护入口迁至「业务设置」页。

CREATE TABLE system_configs (
  code TEXT PRIMARY KEY,
  value TEXT NOT NULL,                    -- JSON 字符串
  updated_at INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- 迁移 ai_config 单行（id=1）→ code='llm'（空值统一 COALESCE 为空串，service 解析时归一为 null）
INSERT INTO system_configs (code, value, updated_at, updated_by)
SELECT 'llm',
       json_object(
         'provider', COALESCE(provider, ''),
         'baseUrl',  COALESCE(base_url, ''),
         'apiKey',   COALESCE(api_key, ''),
         'model',    COALESCE(model, '')
       ),
       COALESCE(updated_at, 0),
       updated_by
FROM ai_config WHERE id = 1;

DROP TABLE ai_config;
