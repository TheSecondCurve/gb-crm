// deal-commissions 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PUT 响应）。
// K56：未配置（commission_id NULL）→ 套全局默认方案（按关系角色推导 + 指定人）；已配置 → 用明细行。
// K9：软删的客户/负责人 ref 不展开（null）；分成人昵称同样软删不展开。
import type { CommissionDefaultRule } from "@gb-crm/shared";

import type { UserRef } from "../users/assemble.js";
import type { CommissionJoinRow, CommissionItemRow } from "./repo.js";

export interface CommissionItemDto {
  userId: number;
  nickname: string | null;
  /** 占税后基数的比例（4 位小数） */
  percentage: number;
  /** 该成交人分成金额（分）：round(税后基数 × percentage)；基数不可算 → null */
  amountCents: number | null;
}

export interface DealCommissionDto {
  dealId: number;
  customer: { id: number; nickname: string; city: string | null } | null;
  owner: UserRef | null;
  stage: string;
  orderNo: string | null;
  dealDate: number;
  /** 金额，整数分（K13，同 deals）；null = 未填 */
  amountCents: number | null;
  /** 税后金额比例 0~1；null = 未填 */
  afterTaxRatio: number | null;
  /** 税后基数（分）：round(amountCents × afterTaxRatio)；缺一 → null */
  baseAmountCents: number | null;
  /** 是否已被特殊配置（false = 套默认方案） */
  isCustomized: boolean;
  items: CommissionItemDto[];
  /** Σ items.percentage */
  totalPercentage: number;
  /** Σ items.amountCents；基数不可算 → null */
  totalAmountCents: number | null;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** 税后基数：amountCents × afterTaxRatio（round 到分）；任一缺 → null */
function baseAmountCentsOf(row: CommissionJoinRow): number | null {
  if (row.amountCents === null || row.afterTaxRatio === null) return null;
  return Math.round(row.amountCents * row.afterTaxRatio);
}

/** 该成交的分成明细（未配置 → 从默认方案推导；已配置 → 取明细行） */
function resolveItems(
  row: CommissionJoinRow,
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultRules: readonly CommissionDefaultRule[],
  userRefs: Map<number, UserRef>,
  base: number | null,
): CommissionItemDto[] {
  let raw: { userId: number; percentage: number }[];
  if (row.commissionId !== null) {
    raw = (itemsByCommission.get(row.commissionId) ?? []).map((i) => ({
      userId: i.userId,
      percentage: i.percentage,
    }));
  } else {
    // 默认方案：owner → 客户归属人；dealOwner → 成交负责人；user → 指定人；同人多次出现合并比例
    const acc = new Map<number, number>();
    for (const rule of defaultRules) {
      let uid: number | null = null;
      if (rule.source === "owner") uid = row.customerOwnerId;
      else if (rule.source === "dealOwner") uid = row.ownerId;
      else uid = rule.userId ?? null;
      if (uid === null) continue;
      acc.set(uid, (acc.get(uid) ?? 0) + rule.percentage);
    }
    raw = [...acc.entries()].map(([userId, percentage]) => ({ userId, percentage }));
  }

  return raw.map((item) => ({
    userId: item.userId,
    nickname: userRefs.get(item.userId)?.nickname ?? null,
    percentage: round4(item.percentage),
    amountCents: base === null ? null : Math.round(base * item.percentage),
  }));
}

export function assembleCommissionRows(
  rows: readonly CommissionJoinRow[],
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultRules: readonly CommissionDefaultRule[],
  userRefs: Map<number, UserRef>,
): DealCommissionDto[] {
  return rows.map((row) => {
    const base = baseAmountCentsOf(row);
    const items = resolveItems(row, itemsByCommission, defaultRules, userRefs, base);
    const totalPercentage = round4(items.reduce((sum, it) => sum + it.percentage, 0));
    const totalAmountCents =
      base === null ? null : items.reduce((sum, it) => sum + (it.amountCents ?? 0), 0);
    return {
      dealId: row.dealId,
      customer:
        row.customerDeletedAt !== null
          ? null
          : { id: row.customerId, nickname: row.customerNickname ?? "", city: row.customerCity },
      owner:
        row.ownerId === null || row.ownerDeletedAt !== null
          ? null
          : (userRefs.get(row.ownerId) ?? { id: row.ownerId, nickname: row.ownerNickname ?? "" }),
      stage: row.stage,
      orderNo: row.orderNo,
      dealDate: row.dealDate,
      amountCents: row.amountCents,
      afterTaxRatio: row.afterTaxRatio,
      baseAmountCents: base,
      isCustomized: row.commissionId !== null,
      items,
      totalPercentage,
      totalAmountCents,
    };
  });
}

export function assembleCommissionRow(
  row: CommissionJoinRow,
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultRules: readonly CommissionDefaultRule[],
  userRefs: Map<number, UserRef>,
): DealCommissionDto {
  return assembleCommissionRows([row], itemsByCommission, defaultRules, userRefs)[0]!;
}
