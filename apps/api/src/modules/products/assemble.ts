// products 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PATCH 响应）。
// isPackage 库存 0/1，对外 boolean；createdBy/updatedBy 展开 { id, nickname } | null（live only，K9）；
// deletedAt 不输出。批量展开避免 N+1（一页 ≤100 行）。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import type { ProductRow } from "./repo.js";

export interface ProductDto {
  id: number;
  name: string;
  notes: string | null;
  sopUrl: string | null;
  packageIncludes: string | null;
  deliveryCycle: string | null;
  productType: string;
  isPackage: boolean;
  status: string;
  /** K13：integer 分；null = 未定价 */
  priceCents: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

function toDto(row: ProductRow, refs: Map<number, UserRef>): ProductDto {
  const ref = (id: number | null): UserRef | null => (id === null ? null : (refs.get(id) ?? null));
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    sopUrl: row.sopUrl,
    packageIncludes: row.packageIncludes,
    deliveryCycle: row.deliveryCycle,
    productType: row.productType,
    isPackage: row.isPackage === 1,
    status: row.status,
    priceCents: row.priceCents,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: ref(row.createdBy),
    updatedBy: ref(row.updatedBy),
  };
}

export function assembleProducts(db: Db, rows: readonly ProductRow[]): ProductDto[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) ids.add(row.createdBy);
    if (row.updatedBy !== null) ids.add(row.updatedBy);
  }
  // 只展开 live 用户（K9）
  const refs = new Map<number, UserRef>();
  if (ids.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
      .all();
    for (const u of found) refs.set(u.id, u);
  }
  return rows.map((row) => toDto(row, refs));
}

export function assembleProduct(db: Db, row: ProductRow): ProductDto {
  return assembleProducts(db, [row])[0]!;
}
