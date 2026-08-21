-- 0000_init.sql 不含 PRAGMA。foreign_keys / busy_timeout 按连接设置，WAL 虽可持久化但统一放 client.ts：
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--   PRAGMA busy_timeout = 5000;
--   PRAGMA synchronous = NORMAL;
-- 新建文件后 chmod 600。

CREATE TABLE users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_record_id  TEXT,
  username          TEXT,
  password_hash     TEXT,
  nickname          TEXT NOT NULL,
  real_name         TEXT,
  phone             TEXT,
  wechat            TEXT,
  job_title         TEXT NOT NULL DEFAULT 'other'
                    CHECK (job_title IN (
                      'ip','partner','ops','assistant','content',
                      'other','part_time_helper','intern'
                    )),
  system_role       TEXT CHECK (system_role IN ('admin','operator','assistant')),
  employment_status TEXT NOT NULL DEFAULT 'employed'
                    CHECK (employment_status IN ('employed','handing_over','left')),
  account_status    TEXT NOT NULL DEFAULT 'disabled'
                    CHECK (account_status IN ('enabled','disabled')),
  duties            TEXT,
  notes             TEXT,
  feishu_user_id    TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at        INTEGER
);

CREATE UNIQUE INDEX users_feishu_record_id_uq
  ON users(feishu_record_id) WHERE feishu_record_id IS NOT NULL;
CREATE UNIQUE INDEX users_username_live_uq
  ON users(username) WHERE username IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       INTEGER NOT NULL,  -- 绝对 7d 锚点
  expires_at       INTEGER NOT NULL,  -- idle 12h 截止
  last_touched_at  INTEGER NOT NULL,
  ip               TEXT,
  user_agent       TEXT
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE channels (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_record_id  TEXT,
  name              TEXT NOT NULL,
  description       TEXT,
  account_id        TEXT,
  register_phone    TEXT,
  registrant        TEXT,
  real_name_person  TEXT,
  login_device      TEXT,
  notes             TEXT,
  platform          TEXT NOT NULL DEFAULT 'other'
                    CHECK (platform IN (
                      'wechat','weibo','xiaohongshu','douyin','xiaoyuzhou',
                      'other','bilibili','xigua','wechat_channels'
                    )),
  channel_type      TEXT NOT NULL DEFAULT 'private'
                    CHECK (channel_type IN (
                      'private','public','private_assistant',
                      'public_assistant','fixed_wechat'
                    )),
  account_type      TEXT NOT NULL DEFAULT 'public_account'
                    CHECK (account_type IN (
                      'public_account','private_assistant','fixed_wechat',
                      'wechat_group','weibo_group','xhs_group'
                    )),
  status            TEXT NOT NULL DEFAULT 'operating'
                    CHECK (status IN ('operating','paused','pending')),
  follower_count    INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at        INTEGER
);
CREATE UNIQUE INDEX channels_feishu_record_id_uq
  ON channels(feishu_record_id) WHERE feishu_record_id IS NOT NULL;

CREATE TABLE channel_owners (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_record_id  TEXT,
  name              TEXT NOT NULL,
  notes             TEXT,
  sop_url           TEXT,
  package_includes  TEXT,
  delivery_cycle    TEXT,
  product_type      TEXT NOT NULL DEFAULT 'c_consulting'
                    CHECK (product_type IN (
                      'c_consulting','b_consulting','ad_coop','content_coop',
                      'knowledge','circle_sub','campaign','team_delivery'
                    )),
  is_package        INTEGER NOT NULL DEFAULT 0 CHECK (is_package IN (0, 1)),
  status            TEXT NOT NULL DEFAULT 'on_sale'
                    CHECK (status IN ('on_sale','off_sale','in_dev')),
  price_cents       INTEGER,                 -- NULL = 未定价
  feishu_created_date INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at        INTEGER
);
CREATE UNIQUE INDEX products_feishu_record_id_uq
  ON products(feishu_record_id) WHERE feishu_record_id IS NOT NULL;

CREATE TABLE customers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  feishu_record_id      TEXT,
  nickname              TEXT NOT NULL,
  real_name             TEXT,
  title                 TEXT,
  phone                 TEXT,
  wechat                TEXT,
  other_social          TEXT,
  wechat_channels_account TEXT,
  xiaoyuzhou_account    TEXT,
  xiaohongshu_account   TEXT,
  weibo_account         TEXT,
  douyin_account        TEXT,
  country               TEXT,
  city                  TEXT,
  origin_story          TEXT,
  notes                 TEXT,
  profile_url           TEXT,
  customer_type         TEXT NOT NULL DEFAULT 'customer'
                        CHECK (customer_type IN (
                          'guest','customer','company','invite','partner'
                        )),
  parent_id             INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  wechat_openid         TEXT,
  last_followed_at      INTEGER,
  feishu_created_date   INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at            INTEGER
);
CREATE UNIQUE INDEX customers_feishu_record_id_uq
  ON customers(feishu_record_id) WHERE feishu_record_id IS NOT NULL;
CREATE UNIQUE INDEX customers_wechat_openid_live_uq
  ON customers(wechat_openid) WHERE wechat_openid IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX customers_parent_id_idx ON customers(parent_id);
CREATE INDEX customers_phone_idx ON customers(phone);

CREATE TABLE customer_tags (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL CHECK (tag IN (
                'stage_0_1','stage_1_10','stage_10_100',
                'vip','ip','side_hustle','guest','partner'
              )),
  PRIMARY KEY (customer_id, tag)
);

CREATE TABLE customer_owners (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, user_id)
);

CREATE TABLE customer_upsell_owners (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, user_id)
);

CREATE TABLE customer_source_channels (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, channel_id)
);

CREATE TABLE customer_community_channels (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, channel_id)
);
