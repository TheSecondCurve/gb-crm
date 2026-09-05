// deal-commissions 业务规则（§3 service 层）：
// - 列表 = deals LEFT JOIN deal_commissions（未配置 → 套默认方案，isCustomized=false）；
// - 单条：成交不存在/软删 → 404；
// - 配置（PUT /deals/:id/commissions）：items 非空 → upsert 自定义行 + 整表替换明细；
//   items=[] → 删除配置行（还原默认）；每项 userId 必须 live（软删/不存在 422）；
//   同一份明细 userId 去重（重复 422）；Σ percentage ≤ 1 否则 422。
import type {
  CommissionDefaultScheme,
  CommissionItem,
  DealCommissionListQuery,
  DealCommissionPut,
  DealPayoutPatch,
  DealPayoutUpsert,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, type AuditContext } from "../../lib/audit.js";
import { notFound, unprocessable } from "../../plugins/error-handler.js";
import { getCommissionDefault } from "../system/repo.js";
import {
  assembleCommissionRow,
  assembleCommissionRows,
  type DealCommissionDto,
  type DealPayoutDto,
} from "./assemble.js";
import {
  deleteCommissionItems,
  deleteCommissionRowByDealId,
  deletePayoutsByDealId,
  findLiveUserIds,
  getCommissionJoinRow,
  getCommissionRowByDealId,
  getPayoutRow,
  insertCommissionItem,
  insertCommissionRow,
  listAllCommissionRows,
  listCommissionRows,
  listItemsByCommissionIds,
  listLiveUserRefs,
  listPayoutsByDealIds,
  updateCommissionConfig,
  updatePayoutStatus,
  upsertPayout,
  type CommissionItemRow,
  type CommissionJoinRow,
  type PayoutRow,
} from "./repo.js";

// better-sqlite3 事务是同步的；tx 与 Db 的查询接口同构，收窄类型以复用 repo 函数
function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

/** 明细校验（422 先于任何写入）：userId 去重、引用 live 用户、Σ percentage ≤ 1 */
function assertItemsValid(db: Db, items: readonly CommissionItem[]): void {
  const seen = new Set<number>();
  let sum = 0;
  const userIds: number[] = [];
  for (const item of items) {
    if (seen.has(item.userId)) {
      throw unprocessable("同一成交人只能配置一次", [
        { path: "items", message: `重复 user_id: ${item.userId}` },
      ]);
    }
    seen.add(item.userId);
    userIds.push(item.userId);
    sum += item.percentage;
  }
  if (sum > 1) {
    throw unprocessable("分成比例总和不能超过 100%", [
      { path: "items", message: `Σpercentage = ${Math.round(sum * 10000) / 10000} > 1` },
    ]);
  }
  const live = findLiveUserIds(db, userIds);
  const missing = [...new Set(userIds)].filter((id) => !live.has(id));
  if (missing.length > 0) {
    throw unprocessable("成交人不存在或已删除", [
      { path: "items", message: `无效 user_id: ${missing.join(",")}` },
    ]);
  }
}

/** 收集本批成交/明细/默认方案需要的全部 live 用户 ref（避免 N+1） */
function collectUserRefs(
  db: Db,
  rows: readonly CommissionJoinRow[],
  items: readonly CommissionItemRow[],
  scheme: CommissionDefaultScheme,
): Map<number, { id: number; nickname: string }> {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.ownerId !== null) ids.add(row.ownerId);
    if (row.customerOwnerId !== null) ids.add(row.customerOwnerId);
  }
  for (const item of items) ids.add(item.userId);
  for (const rule of scheme.rules) if (rule.userId !== undefined) ids.add(rule.userId);
  return listLiveUserRefs(db, [...ids]);
}

function itemsByCommission(
  rows: readonly CommissionItemRow[],
): Map<number, CommissionItemRow[]> {
  const map = new Map<number, CommissionItemRow[]>();
  for (const row of rows) {
    const arr = map.get(row.commissionId) ?? [];
    arr.push(row);
    map.set(row.commissionId, arr);
  }
  return map;
}

export function listCommissionResult(
  db: Db,
  query: DealCommissionListQuery,
): { data: DealCommissionDto[]; total: number } {
  const { rows, total } = listCommissionRows(db, query);
  const commissionIds = rows.map((r) => r.commissionId).filter((id): id is number => id !== null);
  const items = listItemsByCommissionIds(db, commissionIds);
  const scheme = getCommissionDefault(db);
  const userRefs = collectUserRefs(db, rows, items, scheme);
  const payouts = payoutsByDeal(db, rows.map((r) => r.dealId));
  return {
    data: assembleCommissionRows(rows, itemsByCommission(items), scheme, userRefs, payouts),
    total,
  };
}

/** 导出：与列表同一 WHERE（含日期范围/状态/q），不分页取全部并展开 */
export function exportCommissionResult(
  db: Db,
  query: DealCommissionListQuery,
): DealCommissionDto[] {
  const rows = listAllCommissionRows(db, query);
  const commissionIds = rows.map((r) => r.commissionId).filter((id): id is number => id !== null);
  const items = listItemsByCommissionIds(db, commissionIds);
  const scheme = getCommissionDefault(db);
  const userRefs = collectUserRefs(db, rows, items, scheme);
  const payouts = payoutsByDeal(db, rows.map((r) => r.dealId));
  return assembleCommissionRows(rows, itemsByCommission(items), scheme, userRefs, payouts);
}

export function getDealCommissionResult(db: Db, dealId: number): DealCommissionDto {
  const row = getCommissionJoinRow(db, dealId);
  if (!row || row.dealDeletedAt !== null) throw notFound("成交记录不存在");
  const items = listItemsByCommissionIds(db, row.commissionId === null ? [] : [row.commissionId]);
  const scheme = getCommissionDefault(db);
  const userRefs = collectUserRefs(db, [row], items, scheme);
  const payouts = payoutsByDeal(db, [dealId]);
  return assembleCommissionRow(row, itemsByCommission(items), scheme, userRefs, payouts);
}

/** 配置成交分成：items 非空=覆盖自定义；items=[]=还原默认（删除配置行） */
export function setDealCommission(
  db: Db,
  dealId: number,
  body: DealCommissionPut,
  ctx: AuditContext,
): DealCommissionDto {
  return inTx(db, (tx) => {
    const row = getCommissionJoinRow(tx, dealId);
    if (!row || row.dealDeletedAt !== null) throw notFound("成交记录不存在");
    assertItemsValid(tx, body.items);

    const audit = createAudit(ctx);
    if (body.items.length === 0) {
      const existing = getCommissionRowByDealId(tx, dealId);
      if (existing) {
        deleteCommissionItems(tx, existing.id);
        deleteCommissionRowByDealId(tx, dealId);
      }
    } else {
      const existing = getCommissionRowByDealId(tx, dealId);
      let commissionId: number;
      if (existing) {
        updateCommissionConfig(tx, existing.id, {
          configuredAt: ctx.now,
          configuredBy: ctx.userId,
          ...audit,
        });
        deleteCommissionItems(tx, existing.id);
        commissionId = existing.id;
      } else {
        commissionId = insertCommissionRow(tx, {
          dealId,
          configuredAt: ctx.now,
          configuredBy: ctx.userId,
          ...audit,
        });
      }
      for (const item of body.items) {
        insertCommissionItem(tx, {
          dealCommissionId: commissionId,
          userId: item.userId,
          percentage: item.percentage,
          ...audit,
        });
      }
    }

    const fresh = getCommissionJoinRow(tx, dealId)!;
    const items = listItemsByCommissionIds(
      tx,
      fresh.commissionId === null ? [] : [fresh.commissionId],
    );
    const scheme = getCommissionDefault(tx);
    const userRefs = collectUserRefs(tx, [fresh], items, scheme);
    const payouts = payoutsByDeal(tx, [dealId]);
    return assembleCommissionRow(fresh, itemsByCommission(items), scheme, userRefs, payouts);
  });
}

// ---- payout（v2）----

function payoutsByDeal(db: Db, dealIds: readonly number[]): Map<number, PayoutRow[]> {
  const map = new Map<number, PayoutRow[]>();
  for (const row of listPayoutsByDealIds(db, dealIds)) {
    const arr = map.get(row.dealId) ?? [];
    arr.push(row);
    map.set(row.dealId, arr);
  }
  return map;
}

function toPayoutDto(p: PayoutRow): DealPayoutDto {
  return {
    seq: p.seq,
    payoutDate: p.payoutDate,
    rate: p.rate,
    amountCents: p.amountCents,
    status: p.status as DealPayoutDto["status"],
    paidAt: p.paidAt,
  };
}

/** 该成交的分红池（分）：round(税后基数 × 有效总比例)；任一缺 → null */
function poolCentsOf(db: Db, row: CommissionJoinRow): number | null {
  if (row.amountCents === null || row.afterTaxRatio === null) return null;
  const base = Math.round(row.amountCents * row.afterTaxRatio);
  const scheme = getCommissionDefault(db);
  const totalRatio = row.dealCommissionRatio ?? row.productCommissionRatio ?? scheme.totalRatio;
  return Math.round(base * totalRatio);
}

export function listPayoutResult(db: Db, dealId: number): DealPayoutDto[] {
  const row = getCommissionJoinRow(db, dealId);
  if (!row || row.dealDeletedAt !== null) throw notFound("成交记录不存在");
  return listPayoutsByDealIds(db, [dealId]).map(toPayoutDto);
}

/** 整表替换 payout：payouts=[] 清空；金额=round(分红池×rate)，服务端计算 */
export function setDealPayouts(
  db: Db,
  dealId: number,
  body: DealPayoutUpsert,
  ctx: AuditContext,
): DealPayoutDto[] {
  return inTx(db, (tx) => {
    const row = getCommissionJoinRow(tx, dealId);
    if (!row || row.dealDeletedAt !== null) throw notFound("成交记录不存在");
    if (row.deliveryDate === null) {
      throw unprocessable("交付日期为空，无法设置 payout（完成交付后才计算分红）", [
        { path: "payouts", message: "delivery_date 为空" },
      ]);
    }
    const pool = poolCentsOf(tx, row);
    if (pool === null) {
      throw unprocessable("成交金额/税后比例缺失，无法计算 payout 金额", [
        { path: "payouts", message: "amount_cents 或 after_tax_ratio 为空" },
      ]);
    }

    const audit = createAudit(ctx);
    deletePayoutsByDealId(tx, dealId);
    for (const p of body.payouts) {
      upsertPayout(tx, {
        dealId,
        seq: p.seq,
        payoutDate: p.payoutDate,
        rate: p.rate,
        amountCents: Math.round(pool * p.rate),
        status: "pending",
        paidAt: null,
        ...audit,
      });
    }
    return listPayoutsByDealIds(tx, [dealId]).map(toPayoutDto);
  });
}

/** payout 状态流转：pending↔paid（paid 记 paid_at） */
export function patchDealPayoutStatus(
  db: Db,
  dealId: number,
  seq: number,
  body: DealPayoutPatch,
  ctx: AuditContext,
): DealPayoutDto {
  return inTx(db, (tx) => {
    const row = getCommissionJoinRow(tx, dealId);
    if (!row || row.dealDeletedAt !== null) throw notFound("成交记录不存在");
    if (!getPayoutRow(tx, dealId, seq)) throw notFound("payout 不存在");
    updatePayoutStatus(tx, dealId, seq, {
      status: body.status,
      paidAt: body.status === "paid" ? ctx.now : null,
      updatedAt: ctx.now,
      updatedBy: ctx.userId,
    });
    return toPayoutDto(getPayoutRow(tx, dealId, seq)!);
  });
}
