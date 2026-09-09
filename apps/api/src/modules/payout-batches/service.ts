// payout-batches 业务规则（§3 service 层，K59）：
// - 状态机 draft→locked→paid + locked→draft（unlock）；非法迁移一律 409 CONFLICT；
// - 创建批次事务内自动纳入：范围内 status='pending' 且未被任何 draft/locked 批次占用的 payout；
// - 手动添加：payout 存在(404) / 非 pending(409) / 已在本批次(409) / 已在其它活跃批次(409 带批次信息)；
// - lock 校验全部明细底层 payout 仍存在且 pending（stale 明细 422 带清单），事务快照金额 +
//   按当前分成解析（复用 deal-commissions resolveParticipantSplits）跑 splitPayoutAmount 物化 shares；
// - mark-paid 事务逐条把底层 payout（存在且 pending）置 paid，返回 meta {marked, skipped}。
import { splitPayoutAmount } from "@gb-crm/shared";
import type {
  PayoutBatchCandidatesQuery,
  PayoutBatchCreate,
  PayoutBatchItemAdd,
  PayoutBatchListQuery,
  PayoutBatchPatch,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, updateAudit, type AuditContext } from "../../lib/audit.js";
import { excelDayText } from "../../lib/excel-date.js";
import {
  ApiError,
  conflict,
  notFound,
  unprocessable,
} from "../../plugins/error-handler.js";
import {
  resolveParticipantSplits,
} from "../deal-commissions/assemble.js";
import {
  getPayoutRow,
  listItemsByCommissionIds,
  listLiveUserRefs,
  listPayoutsByDealIds,
  updatePayoutStatus,
  type CommissionItemRow,
  type PayoutRow,
} from "../deal-commissions/repo.js";
import { getCommissionDefault } from "../system/repo.js";
import {
  assembleBatchItems,
  assembleBatchListRow,
  assembleCandidates,
  buildSummary,
  type PayoutBatchCandidateDto,
  type PayoutBatchDetailDto,
  type PayoutBatchListItemDto,
} from "./assemble.js";
import {
  clearItemSnapshots,
  deleteBatch,
  deleteBatchItem,
  deleteSharesByItemIds,
  findActiveBatchItem,
  getBatchItemRow,
  getBatchRow,
  insertBatch,
  insertBatchItem,
  insertShare,
  itemStatsByBatchIds,
  listBatchItemRows,
  listBatchRows,
  listCandidateRows,
  listSharesByItemIds,
  snapshotItem,
  updateBatch,
  type BatchItemRow,
  type PayoutBatchRow,
  type ShareRow,
} from "./repo.js";

function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

function requireBatch(db: Db, id: number): PayoutBatchRow {
  const batch = getBatchRow(db, id);
  if (!batch) throw notFound("批次不存在");
  return batch;
}

function assertDraft(batch: PayoutBatchRow, action: string): void {
  if (batch.status !== "draft") throw conflict(`仅草稿批次可${action}`);
}

function payoutsByDeal(rows: readonly PayoutRow[]): Map<number, PayoutRow[]> {
  const map = new Map<number, PayoutRow[]>();
  for (const row of rows) {
    const arr = map.get(row.dealId) ?? [];
    arr.push(row);
    map.set(row.dealId, arr);
  }
  return map;
}

function groupByCommission(rows: readonly CommissionItemRow[]): Map<number, CommissionItemRow[]> {
  const map = new Map<number, CommissionItemRow[]>();
  for (const row of rows) {
    const arr = map.get(row.commissionId) ?? [];
    arr.push(row);
    map.set(row.commissionId, arr);
  }
  return map;
}

function groupByItem(rows: readonly ShareRow[]): Map<number, ShareRow[]> {
  const map = new Map<number, ShareRow[]>();
  for (const row of rows) {
    const arr = map.get(row.itemId) ?? [];
    arr.push(row);
    map.set(row.itemId, arr);
  }
  return map;
}

/** 收集明细展开/分成解析/快照 shares 需要的全部 live 用户 ref */
function collectUserRefs(
  db: Db,
  items: readonly BatchItemRow[],
  itemsByCommission: Map<number, CommissionItemRow[]>,
  shareRows: readonly ShareRow[],
): Map<number, { id: number; nickname: string }> {
  const scheme = getCommissionDefault(db);
  const ids = new Set<number>();
  for (const row of items) {
    if (row.ownerId !== null) ids.add(row.ownerId);
    if (row.customerOwnerId !== null) ids.add(row.customerOwnerId);
    for (const s of resolveParticipantSplits(row, itemsByCommission, scheme)) ids.add(s.userId);
  }
  for (const s of shareRows) ids.add(s.userId);
  return listLiveUserRefs(db, [...ids]);
}

/** 批次详情（GET :id / 创建 / 写操作后的统一响应）：batch + items + summary */
export function getBatchDetail(db: Db, id: number): PayoutBatchDetailDto {
  const batch = requireBatch(db, id);
  const itemRows = listBatchItemRows(db, id);
  const dealIds = [...new Set(itemRows.map((r) => r.dealId))];
  const payouts = payoutsByDeal(listPayoutsByDealIds(db, dealIds));
  const scheme = getCommissionDefault(db);
  const itemsByCommission = groupByCommission(
    listItemsByCommissionIds(
      db,
      itemRows.map((r) => r.commissionId).filter((cid): cid is number => cid !== null),
    ),
  );
  const shareRows =
    batch.status === "draft" ? [] : listSharesByItemIds(db, itemRows.map((r) => r.id));
  const userRefs = collectUserRefs(db, itemRows, itemsByCommission, shareRows);

  const items = assembleBatchItems(
    batch.status as "draft" | "locked" | "paid",
    itemRows,
    payouts,
    itemsByCommission,
    scheme,
    userRefs,
    groupByItem(shareRows),
  );
  const totalAmountCents = items.reduce((sum, it) => sum + (it.payoutAmountCents ?? 0), 0);
  const batchDto: PayoutBatchListItemDto = {
    ...assembleBatchListRow(batch, undefined),
    itemCount: items.length,
    totalAmountCents,
  };
  return { batch: batchDto, items, summary: buildSummary(items) };
}

export function listBatches(
  db: Db,
  query: PayoutBatchListQuery,
): { data: PayoutBatchListItemDto[]; total: number } {
  const { rows, total } = listBatchRows(db, query);
  const stats = new Map(itemStatsByBatchIds(db, rows.map((r) => r.id)).map((s) => [s.batchId, s]));
  return { data: rows.map((row) => assembleBatchListRow(row, stats.get(row.id))), total };
}

/** 创建草稿批次并自动纳入范围内全部未占用待发 payout，返回完整详情 */
export function createBatch(
  db: Db,
  body: PayoutBatchCreate,
  ctx: AuditContext,
): PayoutBatchDetailDto {
  return inTx(db, (tx) => {
    const audit = createAudit(ctx);
    const name = body.name ?? `发放 ${excelDayText(body.startDate)}~${excelDayText(body.endDate)}`;
    const batchId = insertBatch(tx, {
      name,
      rangeStart: body.startDate,
      rangeEnd: body.endDate,
      status: "draft",
      ...audit,
    });
    const candidates = listCandidateRows(tx, {
      startDate: body.startDate,
      endDate: body.endDate,
    });
    for (const c of candidates) {
      if (c.activeBatchId !== null) continue; // 已被其它 draft/locked 批次占用
      insertBatchItem(tx, { batchId, dealId: c.dealId, seq: c.seq, ...audit });
    }
    return getBatchDetail(tx, batchId);
  });
}

/** 待发候选列表（不分页，payoutDate 升序），shares 为当前分成解析的实时预览 */
export function listCandidates(
  db: Db,
  query: PayoutBatchCandidatesQuery,
): PayoutBatchCandidateDto[] {
  const rows = listCandidateRows(db, query);
  const scheme = getCommissionDefault(db);
  const itemsByCommission = groupByCommission(
    listItemsByCommissionIds(
      db,
      rows.map((r) => r.commissionId).filter((cid): cid is number => cid !== null),
    ),
  );
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.ownerId !== null) ids.add(row.ownerId);
    if (row.customerOwnerId !== null) ids.add(row.customerOwnerId);
    for (const s of resolveParticipantSplits(row, itemsByCommission, scheme)) ids.add(s.userId);
  }
  const userRefs = listLiveUserRefs(db, [...ids]);
  return assembleCandidates(rows, itemsByCommission, scheme, userRefs);
}

/** 仅 draft 可改名；空 PATCH（无 name 键）→ 422 */
export function patchBatch(
  db: Db,
  id: number,
  body: PayoutBatchPatch,
  ctx: AuditContext,
): PayoutBatchDetailDto {
  const batch = requireBatch(db, id);
  assertDraft(batch, "修改");
  if (body.name === undefined) {
    throw unprocessable("没有可更新的字段", [{ path: "name", message: "必填" }]);
  }
  updateBatch(db, id, { name: body.name, ...updateAudit(ctx) });
  return getBatchDetail(db, id);
}

/** 仅 draft 可删（硬删，明细/shares 走 ON DELETE CASCADE） */
export function removeBatch(db: Db, id: number): void {
  const batch = requireBatch(db, id);
  assertDraft(batch, "删除");
  deleteBatch(db, id);
}

export function addItem(
  db: Db,
  id: number,
  body: PayoutBatchItemAdd,
  ctx: AuditContext,
): PayoutBatchDetailDto {
  const batch = requireBatch(db, id);
  assertDraft(batch, "添加明细");
  const payout = getPayoutRow(db, body.dealId, body.seq);
  if (!payout) throw notFound("payout 不存在");
  if (payout.status !== "pending") throw conflict("该 payout 已发放，不能加入批次");
  const occupying = findActiveBatchItem(db, body.dealId, body.seq);
  if (occupying) {
    if (occupying.batchId === id) throw conflict("该 payout 已在本批次中");
    throw new ApiError(409, "CONFLICT", `该 payout 已在批次「${occupying.batchName}」中`, {
      batchId: occupying.batchId,
      batchName: occupying.batchName,
    });
  }
  insertBatchItem(db, { batchId: id, dealId: body.dealId, seq: body.seq, ...createAudit(ctx) });
  return getBatchDetail(db, id);
}

export function removeItem(db: Db, id: number, itemId: number): PayoutBatchDetailDto {
  const batch = requireBatch(db, id);
  assertDraft(batch, "移除明细");
  if (!getBatchItemRow(db, id, itemId)) throw notFound("批次明细不存在");
  deleteBatchItem(db, itemId);
  return getBatchDetail(db, id);
}

/** 锁定：全部明细底层 payout 必须存在且 pending（否则 422 带 stale 清单）；事务物化快照 + shares */
export function lockBatch(db: Db, id: number, ctx: AuditContext): PayoutBatchDetailDto {
  return inTx(db, (tx) => {
    const batch = requireBatch(tx, id);
    assertDraft(batch, "锁定");
    const itemRows = listBatchItemRows(tx, id);
    const payouts = payoutsByDeal(
      listPayoutsByDealIds(tx, [...new Set(itemRows.map((r) => r.dealId))]),
    );

    const staleItems: { itemId: number; dealId: number; seq: number; reason: string }[] = [];
    for (const item of itemRows) {
      const payout = payouts.get(item.dealId)?.find((p) => p.seq === item.seq);
      if (!payout) {
        staleItems.push({ itemId: item.id, dealId: item.dealId, seq: item.seq, reason: "missing" });
      } else if (payout.status !== "pending") {
        staleItems.push({ itemId: item.id, dealId: item.dealId, seq: item.seq, reason: "paid" });
      }
    }
    if (staleItems.length > 0) {
      throw unprocessable("存在已失效的批次明细，请先移除", { staleItems });
    }

    const scheme = getCommissionDefault(tx);
    const itemsByCommission = groupByCommission(
      listItemsByCommissionIds(
        tx,
        itemRows.map((r) => r.commissionId).filter((cid): cid is number => cid !== null),
      ),
    );
    const audit = updateAudit(ctx);
    for (const item of itemRows) {
      const payout = payouts.get(item.dealId)!.find((p) => p.seq === item.seq)!;
      snapshotItem(tx, item.id, {
        amountCents: payout.amountCents,
        payoutDate: payout.payoutDate,
        rate: payout.rate,
        ...audit,
      });
      const splits = resolveParticipantSplits(item, itemsByCommission, scheme);
      for (const share of splitPayoutAmount(payout.amountCents, splits)) {
        insertShare(tx, { itemId: item.id, userId: share.userId, amountCents: share.amountCents });
      }
    }
    updateBatch(tx, id, { status: "locked", lockedAt: ctx.now, ...audit });
    return getBatchDetail(tx, id);
  });
}

/** 解锁：清 items 快照列 + 删 shares，回到 draft（不留历史，K59） */
export function unlockBatch(db: Db, id: number, ctx: AuditContext): PayoutBatchDetailDto {
  return inTx(db, (tx) => {
    const batch = requireBatch(tx, id);
    if (batch.status !== "locked") throw conflict("仅已锁定批次可解锁");
    const itemRows = listBatchItemRows(tx, id);
    deleteSharesByItemIds(tx, itemRows.map((r) => r.id));
    clearItemSnapshots(tx, id, updateAudit(ctx));
    updateBatch(tx, id, { status: "draft", lockedAt: null, ...updateAudit(ctx) });
    return getBatchDetail(tx, id);
  });
}

/** 批量标记已发：逐条把底层 payout（存在且 pending）置 paid/paid_at=now；批次 → paid */
export function markBatchPaid(
  db: Db,
  id: number,
  ctx: AuditContext,
): { detail: PayoutBatchDetailDto; marked: number; skipped: number } {
  return inTx(db, (tx) => {
    const batch = requireBatch(tx, id);
    if (batch.status !== "locked") throw conflict("仅已锁定批次可标记已发");
    const itemRows = listBatchItemRows(tx, id);
    const payouts = payoutsByDeal(
      listPayoutsByDealIds(tx, [...new Set(itemRows.map((r) => r.dealId))]),
    );
    let marked = 0;
    let skipped = 0;
    for (const item of itemRows) {
      const payout = payouts.get(item.dealId)?.find((p) => p.seq === item.seq);
      if (payout && payout.status === "pending") {
        updatePayoutStatus(tx, item.dealId, item.seq, {
          status: "paid",
          paidAt: ctx.now,
          updatedAt: ctx.now,
          updatedBy: ctx.userId,
        });
        marked += 1;
      } else {
        skipped += 1;
      }
    }
    updateBatch(tx, id, { status: "paid", paidAt: ctx.now, ...updateAudit(ctx) });
    return { detail: getBatchDetail(tx, id), marked, skipped };
  });
}
