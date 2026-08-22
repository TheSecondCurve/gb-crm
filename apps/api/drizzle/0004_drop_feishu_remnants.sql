-- 2026-08 产品决策（K38）：清理最后三个飞书历史列
-- users.feishu_user_id / products.feishu_created_date / customers.feishu_created_date。
-- 均为普通可空列（无索引/FK），直接 DROP COLUMN（SQLite 3.35+）。
ALTER TABLE users DROP COLUMN feishu_user_id;
ALTER TABLE products DROP COLUMN feishu_created_date;
ALTER TABLE customers DROP COLUMN feishu_created_date;
