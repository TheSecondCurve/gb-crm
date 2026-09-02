// deal-commissions 业务规则（§3 service 层）：
// - 列表 = deals LEFT JOIN deal_commissions（未配置 → 套默认方案，isCustomized=false）；
// - 单条：成交不存在/软删 → 404；
// - 配置（PUT /deals/:id/commissions）：items 非空 → upsert 自定义行 + 整表替换明细；
//   items=[] → 删除配置行（还原默认）；每项 userId 必须 live（软删/不存在 422）；
//   同一份明细 userId 去重（重复 422）；Σ percentage ≤ 1 否则 422。
import type {
  CommissionDefaultRule,
  CommissionItem,
  DealCommissionListQuery,
  DealCommissionPut,
} from "@gb-crm/shared";

import type { Db } from "../../db/client.js";
import { createAudit, type AuditContext } from "../../lib/audit.js";
import { notFound, unprocessable } from "../../plugins/error-handler.js";
import { getCommissionDefault } from "../system/repo.js";
import {
  assembleCommissionRow,
  assembleCommissionRows,
  type DealCommissionDto,
} from "./assemble.js";
import {
  deleteCommissionItems,
  deleteCommissionRowByDealId,
  findLiveUserIds,
  getCommissionJoinRow,
  getCommissionRowByDealId,
  insertCommissionItem,
  insertCommissionRow,
  listAllCommissionRows,
  listCommissionRows,
  listItemsByCommissionIds,
  listLiveUserRefs,
  updateCommissionConfig,
  type CommissionItemRow,
  type CommissionJoinRow,
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
  rules: readonly CommissionDefaultRule[],
): Map<number, { id: number; nickname: string }> {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.ownerId !== null) ids.add(row.ownerId);
    if (row.customerOwnerId !== null) ids.add(row.customerOwnerId);
  }
  for (const item of items) ids.add(item.userId);
  for (const rule of rules) if (rule.userId !== undefined) ids.add(rule.userId);
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
  const rules = getCommissionDefault(db);
  const userRefs = collectUserRefs(db, rows, items, rules);
  return { data: assembleCommissionRows(rows, itemsByCommission(items), rules, userRefs), total };
}

/** 导出：与列表同一 WHERE（含日期范围/状态/q），不分页取全部并展开 */
export function exportCommissionResult(
  db: Db,
  query: DealCommissionListQuery,
): DealCommissionDto[] {
  const rows = listAllCommissionRows(db, query);
  const commissionIds = rows.map((r) => r.commissionId).filter((id): id is number => id !== null);
  const items = listItemsByCommissionIds(db, commissionIds);
  const rules = getCommissionDefault(db);
  const userRefs = collectUserRefs(db, rows, items, rules);
  return assembleCommissionRows(rows, itemsByCommission(items), rules, userRefs);
}

export function getDealCommissionResult(db: Db, dealId: number): DealCommissionDto {
  const row = getCommissionJoinRow(db, dealId);
  if (!row || row.dealDeletedAt !== null) throw notFound("成交记录不存在");
  const items = listItemsByCommissionIds(db, row.commissionId === null ? [] : [row.commissionId]);
  const rules = getCommissionDefault(db);
  const userRefs = collectUserRefs(db, [row], items, rules);
  return assembleCommissionRow(row, itemsByCommission(items), rules, userRefs);
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
    const rules = getCommissionDefault(tx);
    const userRefs = collectUserRefs(tx, [fresh], items, rules);
    return assembleCommissionRow(fresh, itemsByCommission(items), rules, userRefs);
  });
}
