// deal-commissions 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = PUT 响应）。
// K56 v2：三级分红——税后基数 × 总比例 = 分红池；每人 = round(分红池 × 内部分配比例)。
// 未配置（commission_id NULL）→ 套全局默认方案（总是含 成交负责人 + 客户归属人，再叠加指定人）；
// 已配置 → 用明细行（内部分配）。K9：软删的客户/负责人 ref 不展开（null）；分成人昵称同样软删不展开。
import type { CommissionDefaultScheme } from "@gb-crm/shared";

import type { UserRef } from "../users/assemble.js";
import type { CommissionJoinRow, CommissionItemRow, PayoutRow } from "./repo.js";

export interface CommissionItemDto {
  userId: number;
  nickname: string | null;
  /** 占分红池的内部分配比例（4 位小数） */
  percentage: number;
  /** 该成交人分成金额（分）：round(分红池 × percentage)；分红池不可算 → null */
  amountCents: number | null;
}

export interface DealPayoutDto {
  seq: number;
  /** 支付期（epoch ms UTC） */
  payoutDate: number;
  /** 占分红池比例（0~1） */
  rate: number;
  /** 支付金额（分）：round(分红池 × rate) */
  amountCents: number;
  status: "pending" | "paid";
  paidAt: number | null;
}

export interface DealCommissionDto {
  dealId: number;
  customer: { id: number; nickname: string; city: string | null } | null;
  /** 客户归属人（客户软删/无归属人 → null） */
  customerOwner: UserRef | null;
  /** 成交产品（软删/无产品 → null） */
  product: { id: number; name: string } | null;
  owner: UserRef | null;
  stage: string;
  orderNo: string | null;
  dealDate: number;
  /** 交付日期（可空） */
  deliveryDate: number | null;
  /** 金额，整数分（K13，同 deals）；null = 未填 */
  amountCents: number | null;
  /** 税后金额比例 0~1；null = 未填 */
  afterTaxRatio: number | null;
  /** 有效总比例（成交覆盖 → 产品默认 → 全局默认） */
  totalRatio: number;
  /** 成交单独覆盖的总比例（可空） */
  dealCommissionRatio: number | null;
  /** 产品默认总比例（可空，展示「默认来自产品」） */
  productCommissionRatio: number | null;
  /** 税后基数（分）：round(amountCents × afterTaxRatio)；缺一 → null */
  baseAmountCents: number | null;
  /** 分红池（分）：round(税后基数 × totalRatio)；基数不可算 → null */
  poolAmountCents: number | null;
  /** 是否已被特殊配置（false = 套默认方案） */
  isCustomized: boolean;
  items: CommissionItemDto[];
  /** Σ items.percentage */
  totalPercentage: number;
  /** Σ items.amountCents；分红池不可算 → null */
  totalAmountCents: number | null;
  /** v2 payout：最多 2 个支付期 */
  payouts: DealPayoutDto[];
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/** 税后基数：amountCents × afterTaxRatio（round 到分）；任一缺 → null */
function baseAmountCentsOf(row: CommissionJoinRow): number | null {
  if (row.amountCents === null || row.afterTaxRatio === null) return null;
  return Math.round(row.amountCents * row.afterTaxRatio);
}

/** 有效总比例：成交覆盖 → 产品默认 → 全局默认 */
function totalRatioOf(row: CommissionJoinRow, defaultScheme: CommissionDefaultScheme): number {
  return row.dealCommissionRatio ?? row.productCommissionRatio ?? defaultScheme.totalRatio;
}

/** 该成交的分成明细（未配置 → 从默认方案推导；已配置 → 取明细行） */
function resolveItems(
  row: CommissionJoinRow,
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultScheme: CommissionDefaultScheme,
  userRefs: Map<number, UserRef>,
  pool: number | null,
): CommissionItemDto[] {
  let raw: { userId: number; percentage: number }[];
  if (row.commissionId !== null) {
    raw = (itemsByCommission.get(row.commissionId) ?? []).map((i) => ({
      userId: i.userId,
      percentage: i.percentage,
    }));
  } else {
    // 默认方案：总是包含 成交负责人 + 客户归属人（规则缺席也以 0 占位），再叠加 user 规则；同人合并比例
    const acc = new Map<number, number>();
    const add = (uid: number | null, pct: number) => {
      if (uid === null) return;
      acc.set(uid, (acc.get(uid) ?? 0) + pct);
    };
    const ruleOf = (source: string) => defaultScheme.rules.find((r) => r.source === source);
    add(row.ownerId, ruleOf("dealOwner")?.percentage ?? 0);
    add(row.customerOwnerId, ruleOf("owner")?.percentage ?? 0);
    for (const rule of defaultScheme.rules) {
      if (rule.source === "user") add(rule.userId ?? null, rule.percentage);
    }
    raw = [...acc.entries()].map(([userId, percentage]) => ({ userId, percentage }));
  }

  return raw.map((item) => ({
    userId: item.userId,
    nickname: userRefs.get(item.userId)?.nickname ?? null,
    percentage: round4(item.percentage),
    amountCents: pool === null ? null : Math.round(pool * item.percentage),
  }));
}

export function assembleCommissionRows(
  rows: readonly CommissionJoinRow[],
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultScheme: CommissionDefaultScheme,
  userRefs: Map<number, UserRef>,
  payoutsByDeal: Map<number, PayoutRow[]>,
): DealCommissionDto[] {
  return rows.map((row) => {
    const base = baseAmountCentsOf(row);
    const totalRatio = totalRatioOf(row, defaultScheme);
    const pool = base === null ? null : Math.round(base * totalRatio);
    const items = resolveItems(row, itemsByCommission, defaultScheme, userRefs, pool);
    const totalPercentage = round4(items.reduce((sum, it) => sum + it.percentage, 0));
    const totalAmountCents =
      pool === null ? null : items.reduce((sum, it) => sum + (it.amountCents ?? 0), 0);
    const payouts: DealPayoutDto[] = (payoutsByDeal.get(row.dealId) ?? []).map((p) => ({
      seq: p.seq,
      payoutDate: p.payoutDate,
      rate: p.rate,
      amountCents: p.amountCents,
      status: p.status as DealPayoutDto["status"],
      paidAt: p.paidAt,
    }));
    return {
      dealId: row.dealId,
      customer:
        row.customerDeletedAt !== null
          ? null
          : { id: row.customerId, nickname: row.customerNickname ?? "", city: row.customerCity },
      customerOwner:
        row.customerDeletedAt !== null || row.customerOwnerId === null
          ? null
          : (userRefs.get(row.customerOwnerId) ?? null),
      product:
        row.productId === null || row.productDeletedAt !== null
          ? null
          : { id: row.productId, name: row.productName ?? "" },
      owner:
        row.ownerId === null || row.ownerDeletedAt !== null
          ? null
          : (userRefs.get(row.ownerId) ?? { id: row.ownerId, nickname: row.ownerNickname ?? "" }),
      stage: row.stage,
      orderNo: row.orderNo,
      dealDate: row.dealDate,
      deliveryDate: row.deliveryDate,
      amountCents: row.amountCents,
      afterTaxRatio: row.afterTaxRatio,
      totalRatio,
      dealCommissionRatio: row.dealCommissionRatio,
      productCommissionRatio: row.productCommissionRatio,
      baseAmountCents: base,
      poolAmountCents: pool,
      isCustomized: row.commissionId !== null,
      items,
      totalPercentage,
      totalAmountCents,
      payouts,
    };
  });
}

export function assembleCommissionRow(
  row: CommissionJoinRow,
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultScheme: CommissionDefaultScheme,
  userRefs: Map<number, UserRef>,
  payoutsByDeal: Map<number, PayoutRow[]>,
): DealCommissionDto {
  return assembleCommissionRows([row], itemsByCommission, defaultScheme, userRefs, payoutsByDeal)[0]!;
}
