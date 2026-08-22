// products 业务规则（§3 service 层）：
// - PATCH 内核（K24）与 users 同构：键存在才 SET（null → SET NULL 可空列，priceCents 含在内）；
//   updatedAt 必带 OCC；changes===0 → 软删 404，否则 409 且 data 带当前完整行；
// - K13：priceCents 为 integer 分，非整数由 Zod 挡 422；
// - isPackage：API boolean ↔ 库 0/1 的转换在本层完成；
// - 删除 = 软删。
import type { ProductListQuery, ProductPatch, ProductWrite } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { conflict, notFound } from "../../plugins/error-handler.js";
import { assembleProduct, assembleProducts, type ProductDto } from "./assemble.js";
import {
  getProductByIdAny,
  insertProduct,
  listProducts,
  occUpdateProduct,
  softDeleteProduct,
} from "./repo.js";

export function listProductsResult(
  db: Db,
  query: ProductListQuery,
): { data: ProductDto[]; total: number } {
  const { rows, total } = listProducts(db, query);
  return { data: assembleProducts(db, rows), total };
}

export function getProductResult(db: Db, id: number): ProductDto {
  const row = getProductByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("产品不存在");
  return assembleProduct(db, row);
}

export function createProduct(db: Db, body: ProductWrite, ctx: AuditContext): ProductDto {
  const { isPackage, ...fields } = body;
  const id = insertProduct(db, {
    ...fields,
    isPackage: isPackage ? 1 : 0,
    ...createAudit(ctx),
  });
  return assembleProduct(db, getProductByIdAny(db, id)!);
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证不是数据列） */
const PATCHABLE_KEYS = new Set([
  "name",
  "notes",
  "sopUrl",
  "packageIncludes",
  "deliveryCycle",
  "productType",
  "status",
  "priceCents",
  "defaultTasks",
]);

export function patchProduct(
  db: Db,
  id: number,
  patch: ProductPatch,
  ctx: AuditContext,
): ProductDto {
  // 键存在才 SET；缺席键不动（K24）。非空列传 null 已被 Zod 挡在 422。
  const set: Record<string, unknown> = { ...updateAudit(ctx) };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updatedAt" || value === undefined) continue;
    if (key === "isPackage") {
      set.isPackage = value ? 1 : 0; // API boolean ↔ 库 0/1
      continue;
    }
    if (!PATCHABLE_KEYS.has(key)) continue;
    set[key] = value;
  }

  const changes = occUpdateProduct(db, id, patch.updatedAt, set);
  if (changes === 0) {
    const row = getProductByIdAny(db, id);
    if (!row || row.deletedAt !== null) throw notFound("产品不存在");
    throw conflict("数据已被他人修改，请刷新后重试", assembleProduct(db, row));
  }
  return assembleProduct(db, getProductByIdAny(db, id)!);
}

export function deleteProduct(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteProduct(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("产品不存在");
}
