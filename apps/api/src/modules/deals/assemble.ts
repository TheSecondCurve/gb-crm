// deals 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// 按设计「列表组装（避免 N+1）」批量拉取：live 客户/产品/用户各一次 IN 查询，内存拼装。
// K9：软删的 customer/product/owner/createdBy 不展开（null），deals 行本身保留。
// K42：客户 ref 带 city（供「客户城市」只读列，读 customers.city）。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { customers, products, users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import type { DealRow } from "./repo.js";

export interface CustomerRef {
  id: number;
  nickname: string;
  city: string | null;
  /** v2：客户归属人（customers.owner_id → UserRef，软删 null） */
  owner: UserRef | null;
}

export interface ProductRef {
  id: number;
  name: string;
}

export interface DealDto {
  id: number;
  customerId: number;
  productId: number | null;
  ownerId: number | null;
  stage: string;
  orderNo: string | null;
  paymentRemark: string | null;
  /** epoch ms UTC；非空成交日期 */
  dealDate: number;
  /** epoch ms UTC；null = 未填 */
  deliveryDate: number | null;
  /** 金额，整数分（K13，同 priceCents）；null = 未填 */
  amountCents: number | null;
  /** 税后金额比例 0~1（REAL，如 0.9306）；null = 未填 */
  afterTaxRatio: number | null;
  /** v2：分红总比例 0~1；null = 回退产品/全局默认 */
  commissionRatio: number | null;
  customer: CustomerRef | null;
  product: ProductRef | null;
  owner: UserRef | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export function assembleDeals(db: Db, rows: readonly DealRow[]): DealDto[] {
  // live 客户（customer ref 带 city + 归属人）
  const customerIds = new Set<number>();
  for (const row of rows) customerIds.add(row.customerId);
  const customerRows = new Map<
    number,
    { id: number; nickname: string; city: string | null; ownerId: number | null }
  >();
  if (customerIds.size > 0) {
    const found = db
      .select({
        id: customers.id,
        nickname: customers.nickname,
        city: customers.city,
        ownerId: customers.ownerId,
      })
      .from(customers)
      .where(and(inArray(customers.id, [...customerIds]), isNull(customers.deletedAt)))
      .all();
    for (const c of found) customerRows.set(c.id, c);
  }

  // live 产品
  const productIds = new Set<number>();
  for (const row of rows) if (row.productId !== null) productIds.add(row.productId);
  const productRefs = new Map<number, ProductRef>();
  if (productIds.size > 0) {
    const found = db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(inArray(products.id, [...productIds]), isNull(products.deletedAt)))
      .all();
    for (const p of found) productRefs.set(p.id, { id: p.id, name: p.name });
  }

  // live 用户（owner/createdBy/updatedBy/客户归属人 展开，软删不展开 → null）
  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.ownerId !== null) userIds.add(row.ownerId);
    if (row.createdBy !== null) userIds.add(row.createdBy);
    if (row.updatedBy !== null) userIds.add(row.updatedBy);
  }
  for (const c of customerRows.values()) if (c.ownerId !== null) userIds.add(c.ownerId);
  const userRefs = new Map<number, UserRef>();
  if (userIds.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...userIds]), isNull(users.deletedAt)))
      .all();
    for (const u of found) userRefs.set(u.id, u);
  }

  const userRef = (id: number | null): UserRef | null => (id === null ? null : (userRefs.get(id) ?? null));

  // 客户 ref（含归属人）
  const customerRefs = new Map<number, CustomerRef>();
  for (const [id, c] of customerRows) {
    customerRefs.set(id, {
      id: c.id,
      nickname: c.nickname,
      city: c.city,
      owner: userRef(c.ownerId),
    });
  }

  return rows.map((row) => ({
    id: row.id,
    customerId: row.customerId,
    productId: row.productId,
    ownerId: row.ownerId,
    stage: row.stage,
    orderNo: row.orderNo,
    paymentRemark: row.paymentRemark,
    dealDate: row.dealDate,
    deliveryDate: row.deliveryDate,
    amountCents: row.amountCents,
    afterTaxRatio: row.afterTaxRatio,
    commissionRatio: row.commissionRatio,
    customer: customerRefs.get(row.customerId) ?? null,
    product: row.productId === null ? null : (productRefs.get(row.productId) ?? null),
    owner: userRef(row.ownerId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: userRef(row.createdBy),
    updatedBy: userRef(row.updatedBy),
  }));
}

export function assembleDeal(db: Db, row: DealRow): DealDto {
  return assembleDeals(db, [row])[0]!;
}
