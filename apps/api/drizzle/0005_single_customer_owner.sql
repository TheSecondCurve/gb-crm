-- 2026-08 产品决策（K39）：客户归属人 M2M → 单值。
-- customers.owner_id 可空 FK；多归属人存量保留最小 user_id（确定性规则，当前库无冲突）。
-- 渠道 channel_owners 保持 M2M 不动。
ALTER TABLE customers ADD COLUMN owner_id INTEGER REFERENCES users(id);

UPDATE customers SET owner_id = (
  SELECT user_id FROM customer_owners
  WHERE customer_owners.customer_id = customers.id
  ORDER BY user_id LIMIT 1
);

DROP TABLE customer_owners;

CREATE INDEX customers_owner_id_idx ON customers(owner_id);
