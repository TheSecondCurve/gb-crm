// deals 业务规则（§3 service 层）：
// - PATCH 内核用 lib/patch-kernel.ts（K24）：键存在才 SET；updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行（含 expansions）；
// - K42 单值 FK：customerId 创建必填、不可清空（Zod 挡 null）；productId/ownerId 可空
//   标量，缺席=不动、null=清空；非 null 必须引用 live 行，否则 422；
// - create：customerId 必填（shared schema 要求 positive）；stage 默认 gift；
// - 删除 = 软删。
import type { DealListQuery, DealPatch, DealWrite } from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { notFound, unprocessable } from "../../plugins/error-handler.js";
import { assembleDeal, assembleDeals, type DealDto } from "./assemble.js";
import {
  findLiveCustomerIds,
  findLiveProductIds,
  findLiveUserIds,
  getDealByIdAny,
  insertDeal,
  listDeals,
  occUpdateDeal,
  softDeleteDeal,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

/** 单值 FK 校验（K42）：null/缺席跳过；非 null 必须引用 live 行 */
function assertLiveRefs(
  db: Db,
  refs: { customerId?: number | null; productId?: number | null; ownerId?: number | null },
): void {
  if (refs.customerId !== undefined && refs.customerId !== null) {
    if (!findLiveCustomerIds(db, [refs.customerId]).has(refs.customerId)) {
      throw unprocessable("客户不存在或已删除", [
        { path: "customerId", message: `无效客户 id: ${refs.customerId}` },
      ]);
    }
  }
  if (refs.productId !== undefined && refs.productId !== null) {
    if (!findLiveProductIds(db, [refs.productId]).has(refs.productId)) {
      throw unprocessable("产品不存在或已删除", [
        { path: "productId", message: `无效产品 id: ${refs.productId}` },
      ]);
    }
  }
  if (refs.ownerId !== undefined && refs.ownerId !== null) {
    if (!findLiveUserIds(db, [refs.ownerId]).has(refs.ownerId)) {
      throw unprocessable("负责人不存在或已删除", [
        { path: "ownerId", message: `无效用户 id: ${refs.ownerId}` },
      ]);
    }
  }
}

export function listDealsResult(db: Db, query: DealListQuery): { data: DealDto[]; total: number } {
  const { rows, total } = listDeals(db, query);
  return { data: assembleDeals(db, rows), total };
}

export function getDealResult(db: Db, id: number): DealDto {
  const row = getDealByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("成交记录不存在");
  return assembleDeal(db, row);
}

export function createDeal(db: Db, body: DealWrite, ctx: AuditContext): DealDto {
  return inTx(db, (tx) => {
    // customerId 必填且非 null（Zod positive）；productId/ownerId 可空
    assertLiveRefs(tx, body);
    const id = insertDeal(tx, { ...body, ...createAudit(ctx) });
    return assembleDeal(tx, getDealByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证；单值 FK 走标量内核） */
const PATCHABLE_KEYS = new Set([
  "customerId",
  "productId",
  "ownerId",
  "stage",
  "orderNo",
  "paymentRemark",
  "dealDate",
  "deliveryDate",
  "amountCents",
  "afterTaxRatio",
]);

export function patchDeal(db: Db, id: number, patch: DealPatch, ctx: AuditContext): DealDto {
  return inTx(db, (tx) => {
    // 先校验（422 先于任何写入；事务回滚兜底）
    assertLiveRefs(tx, patch);

    applyScalarPatch(patch, ctx, {
      scalarKeys: PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateDeal(tx, id, patch.updatedAt, set),
      getRowAny: () => getDealByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleDeal(tx, row),
      notFoundMessage: "成交记录不存在",
    });

    return assembleDeal(tx, getDealByIdAny(tx, id)!);
  });
}

export function deleteDeal(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteDeal(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("成交记录不存在");
}
