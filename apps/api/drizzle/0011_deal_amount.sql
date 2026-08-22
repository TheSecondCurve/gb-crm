-- 2026-08 产品决策：成交表补金额字段。
-- amount_cents 整数「分」（K13 约定，同 products.price_cents）；after_tax_ratio REAL 数值型
-- （0~1，如 0.9306，对应飞书「税后系数」）。均可空；已有行自动为 NULL，无 DEFAULT。
ALTER TABLE deals ADD COLUMN amount_cents INTEGER;
ALTER TABLE deals ADD COLUMN after_tax_ratio REAL;
