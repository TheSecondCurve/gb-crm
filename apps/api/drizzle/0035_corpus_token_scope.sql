-- K68 语料同步令牌：scope 加第三档 corpus；expires_at 改可空（corpus 令牌永不过期，
-- 治理靠吊销 + last_used_at 审计）。SQLite 无法就地改列可空性 / CHECK，重建表后原样搬数据。
CREATE TABLE api_tokens_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  token_prefix  TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('read', 'write', 'corpus')),
  name          TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  revoked_by    INTEGER
);

INSERT INTO api_tokens_new (id, user_id, token_hash, token_prefix, scope, name, created_at, expires_at, last_used_at, revoked_at, revoked_by)
SELECT id, user_id, token_hash, token_prefix, scope, name, created_at, expires_at, last_used_at, revoked_at, revoked_by
FROM api_tokens;

DROP TABLE api_tokens;
ALTER TABLE api_tokens_new RENAME TO api_tokens;

CREATE UNIQUE INDEX api_tokens_token_hash_uq ON api_tokens(token_hash);
CREATE INDEX api_tokens_user_id_idx ON api_tokens(user_id);
CREATE INDEX api_tokens_expires_at_idx ON api_tokens(expires_at);
