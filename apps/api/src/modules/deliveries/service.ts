// deliveries 域业务规则（§3 service 层）：
// - 类型/交付单/交付项 PATCH 均走 lib/patch-kernel.ts（K24）：键存在才 SET + OCC；
// - K44：交付单客户集合整表替换（缺席不动、[] 清空、[ids] 替换，客户必须 live）；
// - 交付项创建按交付类型 default_tasks 模板预填任务：项目维度一组（customer_id NULL），
//   客户维度为每个选中客户各生成一组（省略 customerIds = 交付单全部客户）；
// - 任务：done 翻转才写 done_at/done_by；remark 自由编辑；客户维度任务校验客户属于该交付单。
import type {
  DeliverablePatch,
  DeliverableWrite,
  DeliveryListQuery,
  DeliveryPatch,
  DeliveryTaskPatch,
  DeliveryTaskWrite,
  DeliveryTypeListQuery,
  DeliveryTypePatch,
  DeliveryTypeWrite,
  DeliveryWrite,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { conflict, notFound, unprocessable } from "../../plugins/error-handler.js";
import {
  assembleDeliverable,
  assembleDeliverables,
  assembleDelivery,
  assembleDeliveries,
  assembleDeliveryType,
  assembleTask,
  type DeliverableDto,
  type DeliveryDto,
  type DeliveryTaskDto,
  type DeliveryTypeDto,
} from "./assemble.js";
import {
  countLiveDeliveriesByType,
  deleteTask,
  findLiveCustomerIds,
  findLiveDeliveryTypeIds,
  getDeliverableById,
  getDeliverableByIdAny,
  getDeliveryById,
  getDeliveryByIdAny,
  getDeliveryCustomerIds,
  getDeliveryTypeById,
  getDeliveryTypeByIdAny,
  getTaskByIdAny,
  insertDeliverable,
  insertDelivery,
  insertDeliveryType,
  insertTask,
  listDeliverablesByDeliveryIds,
  listDeliveries,
  listDeliveryTypes,
  occUpdateDeliverable,
  occUpdateDelivery,
  occUpdateDeliveryType,
  occUpdateTask,
  replaceDeliveryCustomers,
  softDeleteDeliverable,
  softDeleteDelivery,
  softDeleteDeliveryType,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

function assertLiveType(db: Db, typeId: number): void {
  if (!findLiveDeliveryTypeIds(db, [typeId]).has(typeId)) {
    throw unprocessable("交付类型不存在或已删除", [
      { path: "deliveryTypeId", message: `无效类型 id: ${typeId}` },
    ]);
  }
}

function assertLiveCustomers(db: Db, ids: readonly number[]): void {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const live = findLiveCustomerIds(db, unique);
  const missing = unique.filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable("客户不存在或已删除", [
      { path: "customerIds", message: `无效客户 id: ${missing.join(",")}` },
    ]);
  }
}

// ---- delivery_types ----

export function listDeliveryTypesResult(
  db: Db,
  query: DeliveryTypeListQuery,
): { data: DeliveryTypeDto[]; total: number } {
  const { rows, total } = listDeliveryTypes(db, query);
  return { data: rows.map((r) => assembleDeliveryType(db, r)), total };
}

export function getDeliveryTypeResult(db: Db, id: number): DeliveryTypeDto {
  const row = getDeliveryTypeByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("交付类型不存在");
  return assembleDeliveryType(db, row);
}

const TYPE_PATCHABLE_KEYS = new Set(["name", "kind", "status", "description", "defaultTasks"]);

export function patchDeliveryType(
  db: Db,
  id: number,
  patch: DeliveryTypePatch,
  ctx: AuditContext,
): DeliveryTypeDto {
  return inTx(db, (tx) => {
    applyScalarPatch(patch, ctx, {
      scalarKeys: TYPE_PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateDeliveryType(tx, id, patch.updatedAt, set),
      getRowAny: () => getDeliveryTypeByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleDeliveryType(tx, row),
      notFoundMessage: "交付类型不存在",
    });
    return assembleDeliveryType(tx, getDeliveryTypeByIdAny(tx, id)!);
  });
}

export function createDeliveryType(db: Db, body: DeliveryTypeWrite, ctx: AuditContext): DeliveryTypeDto {
  const id = insertDeliveryType(db, { ...body, ...createAudit(ctx) });
  return assembleDeliveryType(db, getDeliveryTypeByIdAny(db, id)!);
}

export function deleteDeliveryType(db: Db, id: number, ctx: AuditContext): void {
  if (countLiveDeliveriesByType(db, id) > 0) {
    throw unprocessable("该交付类型已被交付单引用，无法删除", [
      { path: "id", message: "类型被引用" },
    ]);
  }
  const changes = softDeleteDeliveryType(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("交付类型不存在");
}

// ---- deliveries ----

export function listDeliveriesResult(
  db: Db,
  query: DeliveryListQuery,
): { data: DeliveryDto[]; total: number } {
  const { rows, total } = listDeliveries(db, query);
  return { data: assembleDeliveries(db, rows), total };
}

export function getDeliveryResult(db: Db, id: number): DeliveryDto {
  const row = getDeliveryByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("交付记录不存在");
  return assembleDelivery(db, row);
}

export function createDelivery(db: Db, body: DeliveryWrite, ctx: AuditContext): DeliveryDto {
  return inTx(db, (tx) => {
    assertLiveType(tx, body.deliveryTypeId);
    assertLiveCustomers(tx, body.customerIds);
    const id = insertDelivery(tx, {
      deliveryTypeId: body.deliveryTypeId,
      startsAt: body.startsAt ?? null,
      endsAt: body.endsAt ?? null,
      remark: body.remark,
      ...createAudit(ctx),
    });
    replaceDeliveryCustomers(tx, id, body.customerIds);
    return assembleDelivery(tx, getDeliveryByIdAny(tx, id)!);
  });
}

const DELIVERY_PATCHABLE_KEYS = new Set(["deliveryTypeId", "startsAt", "endsAt", "remark"]);

export function patchDelivery(
  db: Db,
  id: number,
  patch: DeliveryPatch,
  ctx: AuditContext,
): DeliveryDto {
  return inTx(db, (tx) => {
    if (patch.deliveryTypeId !== undefined) assertLiveType(tx, patch.deliveryTypeId);
    if (patch.customerIds !== undefined) assertLiveCustomers(tx, patch.customerIds);

    applyScalarPatch(patch, ctx, {
      scalarKeys: DELIVERY_PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateDelivery(tx, id, patch.updatedAt, set),
      getRowAny: () => getDeliveryByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleDelivery(tx, row),
      notFoundMessage: "交付记录不存在",
    });

    // 客户集合：缺席不动、[] 清空、[ids] 整表替换（与标量同一事务）
    if (patch.customerIds !== undefined) {
      replaceDeliveryCustomers(tx, id, patch.customerIds);
    }
    return assembleDelivery(tx, getDeliveryByIdAny(tx, id)!);
  });
}

export function deleteDelivery(db: Db, id: number, ctx: AuditContext): void {
  const changes = softDeleteDelivery(db, id, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("交付记录不存在");
}

// ---- deliverables（交付项）----

/** 交付项列表（含任务展开） */
export function listDeliverablesResult(db: Db, deliveryId: number): DeliverableDto[] {
  const delivery = getDeliveryById(db, deliveryId);
  if (!delivery) throw notFound("交付记录不存在");
  return assembleDeliverables(db, listDeliverablesByDeliveryIds(db, [deliveryId]));
}

/** 模板预填：类型 default_tasks 多行文本 → 动作行 */
function templateLines(defaultTasks: string | null | undefined): string[] {
  if (!defaultTasks) return [];
  return defaultTasks
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 目标客户：项目维度 = [null]（单组）；客户维度 = 交付单全部或显式选择的客户 */
function taskTargets(db: Db, deliveryId: number, dimension: string, customerIds: number[] | undefined): (number | null)[] {
  if (dimension === "project") return [null];
  const all = [...getDeliveryCustomerIds(db, deliveryId)];
  if (customerIds !== undefined && customerIds.length > 0) {
    const set = new Set(customerIds);
    const missing = [...set].filter((id) => !all.includes(id));
    if (missing.length > 0) {
      throw unprocessable("所选客户不在该交付的客户集合中", [
        { path: "customerIds", message: `无效客户 id: ${missing.join(",")}` },
      ]);
    }
    return [...set];
  }
  if (all.length === 0) {
    throw unprocessable("交付单暂无客户，请先添加客户", [{ path: "customerIds", message: "空" }]);
  }
  return all;
}

export function createDeliverable(
  db: Db,
  deliveryId: number,
  body: DeliverableWrite,
  ctx: AuditContext,
): DeliverableDto {
  return inTx(db, (tx) => {
    const delivery = getDeliveryById(tx, deliveryId);
    if (!delivery) throw notFound("交付记录不存在");
    assertLiveType(tx, delivery.deliveryTypeId);

    const id = insertDeliverable(tx, {
      deliveryId,
      content: body.content,
      dimension: body.dimension,
      description: body.description,
      deliveryUrl: body.deliveryUrl,
      ...createAudit(ctx),
    });

    // 按类型模板预填动作清单（目标客户：项目 = 单组 null；客户维度 = 全部或显式选择）
    const type = getDeliveryTypeById(tx, delivery.deliveryTypeId);
    const lines = templateLines(type?.defaultTasks);
    const targets = taskTargets(tx, deliveryId, body.dimension, body.customerIds);
    const audit = createAudit(ctx);
    for (const content of lines) {
      for (const customerId of targets) {
        insertTask(tx, { deliverableId: id, customerId, content, done: 0, ...audit });
      }
    }
    return assembleDeliverable(tx, getDeliverableByIdAny(tx, id)!);
  });
}

const DELIVERABLE_PATCHABLE_KEYS = new Set(["content", "description", "deliveryUrl"]);

export function patchDeliverable(
  db: Db,
  deliveryId: number,
  itemId: number,
  patch: DeliverablePatch,
  ctx: AuditContext,
): DeliverableDto {
  return inTx(db, (tx) => {
    const row = getDeliverableByIdAny(tx, itemId);
    if (!row || row.deliveryId !== deliveryId) throw notFound("交付项不存在");
    applyScalarPatch(patch, ctx, {
      scalarKeys: DELIVERABLE_PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateDeliverable(tx, itemId, patch.updatedAt, set),
      getRowAny: () => getDeliverableByIdAny(tx, itemId),
      isDeleted: (r) => r.deletedAt !== null,
      serialize: (r) => assembleDeliverable(tx, r),
      notFoundMessage: "交付项不存在",
    });
    return assembleDeliverable(tx, getDeliverableByIdAny(tx, itemId)!);
  });
}

export function deleteDeliverable(db: Db, deliveryId: number, itemId: number, ctx: AuditContext): void {
  const row = getDeliverableByIdAny(db, itemId);
  if (!row || row.deliveryId !== deliveryId) throw notFound("交付项不存在");
  const changes = softDeleteDeliverable(db, itemId, {
    deletedAt: ctx.now,
    ...updateAudit(ctx),
  });
  if (changes === 0) throw notFound("交付项不存在");
}

// ---- delivery_tasks（动作清单）----

function assertDeliverableLive(db: Db, deliveryId: number, itemId: number): void {
  const row = getDeliverableById(db, itemId);
  if (!row || row.deliveryId !== deliveryId) throw notFound("交付项不存在");
}

export function createTask(
  db: Db,
  deliveryId: number,
  itemId: number,
  body: DeliveryTaskWrite,
  ctx: AuditContext,
): DeliveryTaskDto {
  return inTx(db, (tx) => {
    const item = getDeliverableById(tx, itemId);
    if (!item || item.deliveryId !== deliveryId) throw notFound("交付项不存在");
    // 客户维度任务必带该交付的客户；项目维度必须为空（客户归属不一致 → 422）
    if (item.dimension === "customer") {
      if (body.customerId === undefined) {
        throw unprocessable("客户维度交付项的任务必须指定客户", [{ path: "customerId", message: "必填" }]);
      }
      if (!getDeliveryCustomerIds(tx, deliveryId).has(body.customerId)) {
        throw unprocessable("所选客户不在该交付的客户集合中", [{ path: "customerId", message: "无效" }]);
      }
    } else if (body.customerId !== undefined) {
      throw unprocessable("项目维度交付项的任务不能指定客户", [{ path: "customerId", message: "应为空" }]);
    }
    const id = insertTask(tx, {
      deliverableId: itemId,
      customerId: body.customerId ?? null,
      content: body.content,
      done: 0,
      ...createAudit(ctx),
    });
    return assembleTask(tx, getTaskByIdAny(tx, itemId, id)!);
  });
}

export function patchTask(
  db: Db,
  deliveryId: number,
  itemId: number,
  taskId: number,
  patch: DeliveryTaskPatch,
  ctx: AuditContext,
): DeliveryTaskDto {
  return inTx(db, (tx) => {
    assertDeliverableLive(tx, deliveryId, itemId);
    const row = getTaskByIdAny(tx, itemId, taskId);
    if (!row) throw notFound("交付动作不存在");

    // 键存在才 SET；done 翻转（值变化）才写/清 done_at、done_by
    const set: Record<string, unknown> = { ...updateAudit(ctx) };
    if (patch.content !== undefined) set.content = patch.content;
    if (patch.remark !== undefined) set.remark = patch.remark;
    if (patch.done !== undefined) {
      const done = patch.done ? 1 : 0;
      set.done = done;
      if (row.done !== done) {
        set.doneAt = patch.done ? ctx.now : null;
        set.doneBy = patch.done ? ctx.userId : null;
      }
    }

    const changes = occUpdateTask(tx, itemId, taskId, patch.updatedAt, set);
    if (changes === 0) {
      const current = getTaskByIdAny(tx, itemId, taskId);
      if (!current) throw notFound("交付动作不存在");
      throw conflict("交付动作已被他人修改，请刷新后重试", assembleTask(tx, current));
    }
    return assembleTask(tx, getTaskByIdAny(tx, itemId, taskId)!);
  });
}

export function deleteTaskById(db: Db, deliveryId: number, itemId: number, taskId: number): void {
  assertDeliverableLive(db, deliveryId, itemId);
  const changes = deleteTask(db, itemId, taskId);
  if (changes === 0) throw notFound("交付动作不存在");
}
