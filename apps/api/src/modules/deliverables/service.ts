// deliverables 业务规则（§3 service 层）：
// - 交付项 PATCH 内核用 lib/patch-kernel.ts（K24）：键存在才 SET；updatedAt 必带 OCC；
// - K43：dealId 创建必填；productId 可空（缺席不动、null 清空）；非 null 必须引用 live 行，否则 422；
//   deal 校验同时要求其客户 live（交付项不能挂在幽灵成交上）；
// - 创建时从 product.default_tasks（多行文本）预填初始动作清单（模板复制，之后独立）；
// - 任务子表：createTask 追加；patchTask 改文本/打勾——done 翻转才写 done_at/done_by
//   （done:true 记当前时间与操作人，done:false 清空），任务行级 OCC；deleteTask 硬删。
import type {
  DeliverableListQuery,
  DeliverablePatch,
  DeliverableWrite,
  DeliveryTaskPatch,
  DeliveryTaskWrite,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { conflict, notFound, unprocessable } from "../../plugins/error-handler.js";
import {
  assembleDeliverable,
  assembleDeliverables,
  assembleTasks,
  type DeliverableDto,
  type DeliveryTaskDto,
} from "./assemble.js";
import {
  deleteTask,
  findLiveDealIds,
  findLiveProductIds,
  getDeliverableById,
  getDeliverableByIdAny,
  getLiveProductDefaultTasks,
  getTaskByIdAny,
  insertDeliverable,
  insertTask,
  listDeliverables,
  occUpdateDeliverable,
  occUpdateTask,
  softDeleteDeliverable,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

/** 单值 FK 校验（K43）：null/缺席跳过；非 null 必须引用 live 行 */
function assertLiveRefs(
  db: Db,
  refs: { dealId?: number; productId?: number | null },
): void {
  if (refs.dealId !== undefined) {
    if (!findLiveDealIds(db, [refs.dealId]).has(refs.dealId)) {
      throw unprocessable("成交不存在或已删除（或其客户已删除）", [
        { path: "dealId", message: `无效成交 id: ${refs.dealId}` },
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
}

export function listDeliverablesResult(
  db: Db,
  query: DeliverableListQuery,
): { data: DeliverableDto[]; total: number } {
  const { rows, total } = listDeliverables(db, query);
  return { data: assembleDeliverables(db, rows), total };
}

export function getDeliverableResult(db: Db, id: number): DeliverableDto {
  const row = getDeliverableByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("交付记录不存在");
  return assembleDeliverable(db, row);
}

/** 模板预填：产品 default_tasks 多行文本 → 初始动作清单（trim + 去空行） */
function defaultTaskLines(productId: number | null | undefined, db: Db): string[] {
  if (productId == null) return [];
  const raw = getLiveProductDefaultTasks(db, productId);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createDeliverable(db: Db, body: DeliverableWrite, ctx: AuditContext): DeliverableDto {
  return inTx(db, (tx) => {
    assertLiveRefs(tx, body);
    const id = insertDeliverable(tx, { ...body, ...createAudit(ctx) });
    // 模板复制：创建时从产品默认动作预填，之后完全独立
    const audit = createAudit(ctx);
    for (const content of defaultTaskLines(body.productId, tx)) {
      insertTask(tx, { deliverableId: id, content, done: 0, ...audit });
    }
    return assembleDeliverable(tx, getDeliverableByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证；dealId/productId 走标量内核） */
const PATCHABLE_KEYS = new Set([
  "dealId",
  "productId",
  "status",
  "planDeliverDate",
  "actualDeliverDate",
  "expiryDate",
  "description",
  "deliveryUrl",
]);

export function patchDeliverable(
  db: Db,
  id: number,
  patch: DeliverablePatch,
  ctx: AuditContext,
): DeliverableDto {
  return inTx(db, (tx) => {
    assertLiveRefs(tx, patch);
    applyScalarPatch(patch, ctx, {
      scalarKeys: PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateDeliverable(tx, id, patch.updatedAt, set),
      getRowAny: () => getDeliverableByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleDeliverable(tx, row),
      notFoundMessage: "交付记录不存在",
    });
    return assembleDeliverable(tx, getDeliverableByIdAny(tx, id)!);
  });
}

export function deleteDeliverable(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteDeliverable(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("交付记录不存在");
}

// ---- 任务子表（动作打勾清单） ----

/** 任务端点前置：交付项必须存在且未软删 */
function assertDeliverableLive(db: Db, deliverableId: number): void {
  if (!getDeliverableById(db, deliverableId)) throw notFound("交付记录不存在");
}

export function createTask(
  db: Db,
  deliverableId: number,
  body: DeliveryTaskWrite,
  ctx: AuditContext,
): DeliveryTaskDto {
  return inTx(db, (tx) => {
    assertDeliverableLive(tx, deliverableId);
    const id = insertTask(tx, { deliverableId, content: body.content, done: 0, ...createAudit(ctx) });
    return assembleTasks(tx, [getTaskByIdAny(tx, deliverableId, id)!])[0]!;
  });
}

export function patchTask(
  db: Db,
  deliverableId: number,
  taskId: number,
  patch: DeliveryTaskPatch,
  ctx: AuditContext,
): DeliveryTaskDto {
  return inTx(db, (tx) => {
    assertDeliverableLive(tx, deliverableId);
    const row = getTaskByIdAny(tx, deliverableId, taskId);
    if (!row) throw notFound("交付动作不存在");

    // 键存在才 SET；done 翻转（值变化）才写/清 done_at、done_by
    const set: Record<string, unknown> = { ...updateAudit(ctx) };
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.done !== undefined) {
      const done = patch.done ? 1 : 0;
      set.done = done;
      if (row.done !== done) {
        set.doneAt = patch.done ? ctx.now : null;
        set.doneBy = patch.done ? ctx.userId : null;
      }
    }

    const changes = occUpdateTask(tx, deliverableId, taskId, patch.updatedAt, set);
    if (changes === 0) {
      // 行已不存在（删除竞态）或 updatedAt 不匹配 → 409 带当前状态
      const current = getTaskByIdAny(tx, deliverableId, taskId);
      if (!current) throw notFound("交付动作不存在");
      throw conflict(
        "交付动作已被他人修改，请刷新后重试",
        assembleTasks(tx, [current])[0],
      );
    }
    return assembleTasks(tx, [getTaskByIdAny(tx, deliverableId, taskId)!])[0]!;
  });
}

export function deleteTaskById(db: Db, deliverableId: number, taskId: number): void {
  assertDeliverableLive(db, deliverableId);
  const changes = deleteTask(db, deliverableId, taskId);
  if (changes === 0) throw notFound("交付动作不存在");
}
