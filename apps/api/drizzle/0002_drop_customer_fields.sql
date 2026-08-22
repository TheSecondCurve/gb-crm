-- 2026-08 产品决策：客户表删除 父记录 / 档案页 / 所在社群 / 升单人 / 飞书记录 五个字段。
-- 先删索引，再 DROP COLUMN（SQLite 3.35+）；join 表整表删除。
-- 新库：0000 建出这些对象后由本迁移再删；老库：0000 已应用，本迁移直接删——两种库结果一致。
DROP INDEX customers_feishu_record_id_uq;
DROP INDEX customers_parent_id_idx;
ALTER TABLE customers DROP COLUMN parent_id;
ALTER TABLE customers DROP COLUMN profile_url;
ALTER TABLE customers DROP COLUMN feishu_record_id;
DROP TABLE customer_upsell_owners;
DROP TABLE customer_community_channels;
