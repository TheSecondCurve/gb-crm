-- 后台「授权管理」：吊销令牌记录操作人（吊销历史可追溯）。
-- 现有 revoked_at 表示已吊销；新增 revoked_by = 执行吊销的 users.id（仅管理员可吊销他人令牌）。
ALTER TABLE api_tokens ADD COLUMN revoked_by INTEGER REFERENCES users(id);
