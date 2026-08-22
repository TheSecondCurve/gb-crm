-- 2026-08 产品决策（K41）：客户社交媒体信息表。
-- platform 枚举沿用现有 6 类；同平台允许多个账号（不设 customer+platform 唯一约束）。
-- customers 表 6 个账号字段迁移进新表（非空且非空串），随后删除。
CREATE TABLE customer_social_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN
    ('wechat_channels','xiaoyuzhou','xiaohongshu','weibo','douyin','other')),
  account TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX customer_social_accounts_customer_id_idx
  ON customer_social_accounts(customer_id);

-- 存量迁移：6 个账号字段 → 新表（继承审计列）
INSERT INTO customer_social_accounts
  (customer_id, platform, account, created_at, updated_at, created_by, updated_by)
SELECT id, 'wechat_channels', wechat_channels_account, created_at, updated_at, created_by, updated_by
FROM customers
WHERE wechat_channels_account IS NOT NULL AND wechat_channels_account <> '';

INSERT INTO customer_social_accounts
  (customer_id, platform, account, created_at, updated_at, created_by, updated_by)
SELECT id, 'xiaoyuzhou', xiaoyuzhou_account, created_at, updated_at, created_by, updated_by
FROM customers
WHERE xiaoyuzhou_account IS NOT NULL AND xiaoyuzhou_account <> '';

INSERT INTO customer_social_accounts
  (customer_id, platform, account, created_at, updated_at, created_by, updated_by)
SELECT id, 'xiaohongshu', xiaohongshu_account, created_at, updated_at, created_by, updated_by
FROM customers
WHERE xiaohongshu_account IS NOT NULL AND xiaohongshu_account <> '';

INSERT INTO customer_social_accounts
  (customer_id, platform, account, created_at, updated_at, created_by, updated_by)
SELECT id, 'weibo', weibo_account, created_at, updated_at, created_by, updated_by
FROM customers
WHERE weibo_account IS NOT NULL AND weibo_account <> '';

INSERT INTO customer_social_accounts
  (customer_id, platform, account, created_at, updated_at, created_by, updated_by)
SELECT id, 'douyin', douyin_account, created_at, updated_at, created_by, updated_by
FROM customers
WHERE douyin_account IS NOT NULL AND douyin_account <> '';

INSERT INTO customer_social_accounts
  (customer_id, platform, account, created_at, updated_at, created_by, updated_by)
SELECT id, 'other', other_social, created_at, updated_at, created_by, updated_by
FROM customers
WHERE other_social IS NOT NULL AND other_social <> '';

ALTER TABLE customers DROP COLUMN wechat_channels_account;
ALTER TABLE customers DROP COLUMN xiaoyuzhou_account;
ALTER TABLE customers DROP COLUMN xiaohongshu_account;
ALTER TABLE customers DROP COLUMN weibo_account;
ALTER TABLE customers DROP COLUMN douyin_account;
ALTER TABLE customers DROP COLUMN other_social;
