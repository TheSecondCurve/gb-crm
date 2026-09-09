// payout-batches 序列化 assembler（K21：JSON 一律 camelCase）。
// K59：draft 批次的 payoutDate/rate/payoutAmountCents/shares 全部实时计算（底层 deal_payouts）；
// locked/paid 用锁定快照（items 表 + shares 表），payoutStatus 仍实时展示底层状态。
// stale：draft/locked 时底层 payout 缺失或非 pending（被 PUT 冲掉/已被单独标记已发）；
// paid 批次底层 paid 是 mark-paid 的预期结果，stale 仅当底层缺失或不再是 paid。
import { splitPayoutAmount, type CommissionDefaultScheme, type PayoutBatchStatus } from "@gb-crm/shared";

import { excelDayText } from "../../lib/excel-date.js";
import { resolveParticipantSplits } from "../deal-commissions/assemble.js";
import type { CommissionItemRow, PayoutRow } from "../deal-commissions/repo.js";
import type { UserRef } from "../users/assemble.js";
import type {
  BatchItemRow,
  BatchItemStats,
  PayoutBatchRow,
  PayoutCandidateRow,
  ShareRow,
} from "./repo.js";

export interface PayoutBatchListItemDto {
  id: number;
  name: string;
  rangeStart: number;
  rangeEnd: number;
  status: PayoutBatchStatus;
  itemCount: number;
  /** 总金额（分）：draft=实时 sum 底层 payout；locked/paid=sum 锁定快照 */
  totalAmountCents: number;
  lockedAt: number | null;
  paidAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdBy: UserRef | null;
}

export interface PayoutBatchShareDto {
  userId: number;
  nickname: string | null;
  amountCents: number;
}

export interface PayoutBatchItemDto {
  id: number;
  dealId: number;
  seq: number;
  customer: { id: number; nickname: string } | null;
  product: { id: number; name: string } | null;
  /** 成交负责人 */
  owner: UserRef | null;
  /** 客户归属人 */
  customerOwner: UserRef | null;
  dealDate: number;
  /** 成交月份（Asia/Shanghai 墙钟 YYYY-MM） */
  dealMonth: string;
  dealAmountCents: number | null;
  payoutDate: number | null;
  rate: number | null;
  payoutAmountCents: number | null;
  /** 底层 payout 实时状态（行缺失 → missing） */
  payoutStatus: "pending" | "paid" | "missing";
  stale: boolean;
  shares: PayoutBatchShareDto[];
}

/** 待发候选：与 item DTO 同形（尚无明细行 id），外加活跃批次占用标注 */
export interface PayoutBatchCandidateDto extends Omit<PayoutBatchItemDto, "id" | "stale"> {
  activeBatchId: number | null;
  activeBatchName: string | null;
}

export interface PayoutBatchSummaryEntry {
  userId: number;
  nickname: string | null;
  totalAmountCents: number;
  byMonth: { month: string; amountCents: number }[];
  byProduct: { productId: number | null; productName: string; amountCents: number }[];
}

export interface PayoutBatchDetailDto {
  batch: PayoutBatchListItemDto;
  items: PayoutBatchItemDto[];
  summary: PayoutBatchSummaryEntry[];
}

/** 成交月份 key：Asia/Shanghai 墙钟 "YYYY-MM" */
export const dealMonthOf = (dealDate: number): string => excelDayText(dealDate).slice(0, 7);

export function assembleBatchListRow(
  row: PayoutBatchRow,
  stats: BatchItemStats | undefined,
): PayoutBatchListItemDto {
  const status = row.status as PayoutBatchStatus;
  return {
    id: row.id,
    name: row.name,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    status,
    itemCount: stats?.itemCount ?? 0,
    totalAmountCents: status === "draft"
      ? (stats?.liveTotalCents ?? 0)
      : (stats?.snapshotTotalCents ?? 0),
    lockedAt: row.lockedAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy:
      row.createdBy !== null && row.createdByNickname !== null
        ? { id: row.createdBy, nickname: row.createdByNickname }
        : null,
  };
}

interface DealRefs {
  customerId: number;
  customerNickname: string | null;
  customerDeletedAt: number | null;
  customerOwnerId: number | null;
  productId: number | null;
  productName: string | null;
  productDeletedAt: number | null;
  ownerId: number | null;
  ownerNickname: string | null;
  ownerDeletedAt: number | null;
  commissionId: number | null;
  dealDate: number;
  dealAmountCents: number | null;
}

function dealRefFields(row: DealRefs, userRefs: Map<number, UserRef>) {
  return {
    customer:
      row.customerDeletedAt !== null
        ? null
        : { id: row.customerId, nickname: row.customerNickname ?? "" },
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
    dealDate: row.dealDate,
    dealMonth: dealMonthOf(row.dealDate),
    dealAmountCents: row.dealAmountCents,
  };
}

function liveShares(
  payout: { amountCents: number },
  row: { commissionId: number | null; ownerId: number | null; customerOwnerId: number | null },
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultScheme: CommissionDefaultScheme,
  userRefs: Map<number, UserRef>,
): PayoutBatchShareDto[] {
  const splits = resolveParticipantSplits(row, itemsByCommission, defaultScheme);
  return splitPayoutAmount(payout.amountCents, splits).map((s) => ({
    userId: s.userId,
    nickname: userRefs.get(s.userId)?.nickname ?? null,
    amountCents: s.amountCents,
  }));
}

export function assembleBatchItems(
  batchStatus: PayoutBatchStatus,
  rows: readonly BatchItemRow[],
  payoutsByDeal: Map<number, PayoutRow[]>,
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultScheme: CommissionDefaultScheme,
  userRefs: Map<number, UserRef>,
  sharesByItem: Map<number, ShareRow[]>,
): PayoutBatchItemDto[] {
  const draft = batchStatus === "draft";
  return rows.map((row) => {
    const payout = payoutsByDeal.get(row.dealId)?.find((p) => p.seq === row.seq);
    const payoutStatus: PayoutBatchItemDto["payoutStatus"] = payout
      ? (payout.status as "pending" | "paid")
      : "missing";
    const stale =
      batchStatus === "paid"
        ? !payout || payout.status !== "paid"
        : !payout || payout.status !== "pending";

    let payoutDate: number | null;
    let rate: number | null;
    let payoutAmountCents: number | null;
    let shares: PayoutBatchShareDto[];
    if (draft) {
      payoutDate = payout?.payoutDate ?? null;
      rate = payout?.rate ?? null;
      payoutAmountCents = payout?.amountCents ?? null;
      shares = payout
        ? liveShares(payout, row, itemsByCommission, defaultScheme, userRefs)
        : [];
    } else {
      payoutDate = row.snapshotPayoutDate;
      rate = row.snapshotRate;
      payoutAmountCents = row.snapshotAmountCents;
      shares = (sharesByItem.get(row.id) ?? []).map((s) => ({
        userId: s.userId,
        nickname: userRefs.get(s.userId)?.nickname ?? null,
        amountCents: s.amountCents,
      }));
    }

    return {
      id: row.id,
      dealId: row.dealId,
      seq: row.seq,
      ...dealRefFields(row, userRefs),
      payoutDate,
      rate,
      payoutAmountCents,
      payoutStatus,
      stale,
      shares,
    };
  });
}

export function assembleCandidates(
  rows: readonly PayoutCandidateRow[],
  itemsByCommission: Map<number, CommissionItemRow[]>,
  defaultScheme: CommissionDefaultScheme,
  userRefs: Map<number, UserRef>,
): PayoutBatchCandidateDto[] {
  return rows.map((row) => ({
    dealId: row.dealId,
    seq: row.seq,
    ...dealRefFields(row, userRefs),
    payoutDate: row.payoutDate,
    rate: row.rate,
    payoutAmountCents: row.amountCents,
    payoutStatus: "pending",
    shares: liveShares(row, row, itemsByCommission, defaultScheme, userRefs),
    activeBatchId: row.activeBatchId,
    activeBatchName: row.activeBatchName,
  }));
}

/** 按参与人聚合：totalAmountCents 降序；byMonth 按月份升序；byProduct 按金额降序（无产品归「未选产品」） */
export function buildSummary(items: readonly PayoutBatchItemDto[]): PayoutBatchSummaryEntry[] {
  const acc = new Map<
    number,
    {
      nickname: string | null;
      total: number;
      months: Map<string, number>;
      products: Map<number | null, { productName: string; amount: number }>;
    }
  >();
  for (const item of items) {
    for (const share of item.shares) {
      const entry =
        acc.get(share.userId) ?? {
          nickname: share.nickname,
          total: 0,
          months: new Map<string, number>(),
          products: new Map<number | null, { productName: string; amount: number }>(),
        };
      if (entry.nickname === null) entry.nickname = share.nickname;
      entry.total += share.amountCents;
      entry.months.set(item.dealMonth, (entry.months.get(item.dealMonth) ?? 0) + share.amountCents);
      const pid = item.product?.id ?? null;
      const p = entry.products.get(pid) ?? {
        productName: item.product?.name ?? "未选产品",
        amount: 0,
      };
      p.amount += share.amountCents;
      entry.products.set(pid, p);
      acc.set(share.userId, entry);
    }
  }
  return [...acc.entries()]
    .map(([userId, e]) => ({
      userId,
      nickname: e.nickname,
      totalAmountCents: e.total,
      byMonth: [...e.months.entries()]
        .map(([month, amountCents]) => ({ month, amountCents }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      byProduct: [...e.products.entries()]
        .map(([productId, p]) => ({ productId, productName: p.productName, amountCents: p.amount }))
        .sort((a, b) => b.amountCents - a.amountCents),
    }))
    .sort((a, b) => b.totalAmountCents - a.totalAmountCents);
}
