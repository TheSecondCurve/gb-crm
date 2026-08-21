// products 表 Drizzle 查询（§3：repo 层，路由/服务不写 SQL）。
// list 排除软删；COUNT 与列表同一 WHERE（§9）。K13：price_cents 为 integer 分。
import { and, asc, count, desc, eq, isNull, type SQL } from "drizzle-orm";

import type { ProductListQuery } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { products } from "../../db/schema.js";
import { fuzzyWhere } from "../../lib/fuzzy.js";
import { toOffset } from "../../lib/pagination.js";

export type ProductRow = typeof products.$inferSelect;

/** q 搜索列（§9，SQL 列名）：name,notes */
const SEARCH_COLUMNS = [products.name, products.notes];

// 每资源独立 sort enum（K21）；products: updatedAt | createdAt | name | priceCents
const SORT_COLUMNS = {
  updatedAt: products.updatedAt,
  createdAt: products.createdAt,
  name: products.name,
  priceCents: products.priceCents,
} as const;

function listWhere(query: ProductListQuery): SQL | undefined {
  const conditions: SQL[] = [isNull(products.deletedAt)];
  const fuzzy = fuzzyWhere(query.q ?? "", SEARCH_COLUMNS);
  if (fuzzy) conditions.push(fuzzy);
  if (query.productType !== undefined) conditions.push(eq(products.productType, query.productType));
  if (query.status !== undefined) conditions.push(eq(products.status, query.status));
  // is_package 库存 0/1，query 为 boolean（shared queryBooleanSchema 已 transform）
  if (query.isPackage !== undefined) conditions.push(eq(products.isPackage, query.isPackage ? 1 : 0));
  return and(...conditions);
}

export function listProducts(
  db: Db,
  query: ProductListQuery,
): { rows: ProductRow[]; total: number } {
  const where = listWhere(query);
  // 默认 sort=updatedAt&order=desc，并列 id DESC（§9）
  const sortCol = SORT_COLUMNS[query.sort ?? "updatedAt"];
  const dir = query.order === "asc" ? asc : desc;

  const rows = db
    .select()
    .from(products)
    .where(where)
    .orderBy(dir(sortCol), desc(products.id))
    .limit(query.pageSize)
    .offset(toOffset(query.page, query.pageSize))
    .all();
  const total = db.select({ value: count() }).from(products).where(where).get()?.value ?? 0;
  return { rows, total };
}

/** 含软删行（OCC 失败时区分 404 与 409 用） */
export function getProductByIdAny(db: Db, id: number): ProductRow | undefined {
  return db.select().from(products).where(eq(products.id, id)).get();
}

/** 仅 live 行；软删视为不存在 */
export function getProductById(db: Db, id: number): ProductRow | undefined {
  return db
    .select()
    .from(products)
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .get();
}

export function insertProduct(db: Db, values: typeof products.$inferInsert): number {
  return Number(db.insert(products).values(values).run().lastInsertRowid);
}

/**
 * PATCH 内核 + 行级 OCC（K24）：
 * UPDATE 仅 SET 出现的键（调用方拼好，含 updated_at/updated_by bump），
 * WHERE id=? AND updated_at=? AND deleted_at IS NULL。返回受影响行数。
 */
export function occUpdateProduct(
  db: Db,
  id: number,
  expectedUpdatedAt: number,
  set: Partial<typeof products.$inferInsert>,
): number {
  return db
    .update(products)
    .set(set)
    .where(
      and(eq(products.id, id), eq(products.updatedAt, expectedUpdatedAt), isNull(products.deletedAt)),
    )
    .run().changes;
}

/** 软删：deleted_at=now；返回受影响行数（0 = 不存在或已删） */
export function softDeleteProduct(
  db: Db,
  id: number,
  set: { deletedAt: number; updatedAt: number; updatedBy: number | null },
): number {
  return db
    .update(products)
    .set(set)
    .where(and(eq(products.id, id), isNull(products.deletedAt)))
    .run().changes;
}
