// customer-records 业务规则（§3 service 层）：
// - customerId 取自路由路径（:customerId）；customer soft-delete/不存在 → 404；
//   记录必须归属该 customer（防跨客户越权读单条），否则 404。
// - PATCH 内核用 lib/patch-kernel.ts（K24）：键存在才 SET；updatedAt 必带 OCC；
//   changes===0 → 软删 404，否则 409 且 data 带当前完整行（含 expansions）；
// - create：kind/happenedAt 必填（shared schema 挡 422）；content 可空；
//   新建 kind ∈ {follow_up, lead} 时顺带 bump customers.lastFollowedAt（联动，K55）；
// - delete = 软删。
import type {
  MaintenanceRecordListQuery,
  MaintenanceRecordPatch,
  MaintenanceRecordWrite,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { applyScalarPatch } from "../../lib/patch-kernel.js";
import { notFound } from "../../plugins/error-handler.js";
import {
  assembleCustomerMaintenanceRecord,
  assembleCustomerMaintenanceRecords,
  type CustomerMaintenanceRecordDto,
} from "./assemble.js";
import {
  bumpCustomerLastFollowedAt,
  findLiveCustomerIds,
  getRecordByIdAny,
  insertRecord,
  listRecordsByCustomer,
  occUpdateRecord,
  softDeleteRecord,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

/** path 里的 customer 必须 live（软删/不存在 → 404） */
function assertLiveCustomer(db: Db, customerId: number): void {
  if (!findLiveCustomerIds(db, [customerId]).has(customerId)) {
    throw notFound("客户不存在或已删除");
  }
}

/** 单条记录归属校验：记录不在该 customer 下 → 404（防跨客户读） */
function assertRecordBelongsTo(db: Db, customerId: number, id: number): void {
  const row = getRecordByIdAny(db, id);
  if (!row || row.deletedAt !== null || row.customerId !== customerId) {
    throw notFound("维护记录不存在");
  }
}

export function listRecordsResult(
  db: Db,
  customerId: number,
  query: MaintenanceRecordListQuery,
): { data: CustomerMaintenanceRecordDto[]; total: number } {
  assertLiveCustomer(db, customerId);
  const { rows, total } = listRecordsByCustomer(db, customerId, query);
  return { data: assembleCustomerMaintenanceRecords(db, rows), total };
}

export function getRecordResult(db: Db, customerId: number, id: number): CustomerMaintenanceRecordDto {
  assertLiveCustomer(db, customerId);
  assertRecordBelongsTo(db, customerId, id);
  return assembleCustomerMaintenanceRecord(db, getRecordByIdAny(db, id)!);
}

export function createRecord(
  db: Db,
  customerId: number,
  body: MaintenanceRecordWrite,
  ctx: AuditContext,
): CustomerMaintenanceRecordDto {
  return inTx(db, (tx) => {
    assertLiveCustomer(tx, customerId);
    const id = insertRecord(tx, {
      customerId,
      kind: body.kind,
      happenedAt: body.happenedAt,
      content: body.content ?? null,
      ...createAudit(ctx),
    });
    // K55 联动：跟进/线索记录刷新客户「最近跟进」时间
    if (body.kind === "follow_up" || body.kind === "lead") {
      bumpCustomerLastFollowedAt(tx, customerId, body.happenedAt, updateAudit(ctx));
    }
    return assembleCustomerMaintenanceRecord(tx, getRecordByIdAny(tx, id)!);
  });
}

/** PATCH 可写标量键（updatedAt 是 OCC 凭证） */
const PATCHABLE_KEYS = new Set(["kind", "happenedAt", "content"]);

export function patchRecord(
  db: Db,
  customerId: number,
  id: number,
  patch: MaintenanceRecordPatch,
  ctx: AuditContext,
): CustomerMaintenanceRecordDto {
  return inTx(db, (tx) => {
    assertLiveCustomer(tx, customerId);
    assertRecordBelongsTo(tx, customerId, id);

    applyScalarPatch(patch, ctx, {
      scalarKeys: PATCHABLE_KEYS,
      occUpdate: (set) => occUpdateRecord(tx, id, patch.updatedAt, set),
      getRowAny: () => getRecordByIdAny(tx, id),
      isDeleted: (row) => row.deletedAt !== null,
      serialize: (row) => assembleCustomerMaintenanceRecord(tx, row),
      notFoundMessage: "维护记录不存在",
    });

    return assembleCustomerMaintenanceRecord(tx, getRecordByIdAny(tx, id)!);
  });
}

export function deleteRecord(db: Db, customerId: number, id: number, ctx: AuditContext): void {
  inTx(db, (tx) => {
    assertLiveCustomer(tx, customerId);
    assertRecordBelongsTo(tx, customerId, id);
    const changes = softDeleteRecord(tx, id, {
      deletedAt: ctx.now,
      ...updateAudit(ctx),
    });
    if (changes === 0) throw notFound("维护记录不存在");
  });
}
