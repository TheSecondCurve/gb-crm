-- 2026-08 产品决策（K37）：users / channels / products 三张表也删除 飞书记录（feishu_record_id）。
-- 先删 partial unique 索引，再 DROP COLUMN（SQLite 3.35+）。
DROP INDEX users_feishu_record_id_uq;
DROP INDEX channels_feishu_record_id_uq;
DROP INDEX products_feishu_record_id_uq;
ALTER TABLE users DROP COLUMN feishu_record_id;
ALTER TABLE channels DROP COLUMN feishu_record_id;
ALTER TABLE products DROP COLUMN feishu_record_id;
