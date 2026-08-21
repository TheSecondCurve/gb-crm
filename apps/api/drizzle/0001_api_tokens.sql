-- Agent 个人访问令牌（PAT）。明文只在签发响应出现一次；库内仅存 sha256 hex。
-- scope: read = 只读 GET；write = 走现有 REST，仍受 can() 约束。

CREATE TABLE api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  token_prefix  TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  name          TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

CREATE UNIQUE INDEX api_tokens_token_hash_uq ON api_tokens(token_hash);
CREATE INDEX api_tokens_user_id_idx ON api_tokens(user_id);
CREATE INDEX api_tokens_expires_at_idx ON api_tokens(expires_at);
