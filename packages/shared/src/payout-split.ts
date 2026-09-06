// payout 每人每期金额推导（K56 v2）：期金额 × 内部分配比例，逐人四舍五入到分。
// 不变量：Σ每人 = round(期金额 × Σ比例)；逐人 round 的尾差兜底给比例最大的人（并列取数组首个）。
// API 导出（Payout 明细 sheet）与 Web payout 编辑器预览共用，保证两侧数字一致。
export interface PayoutSplitItem {
  userId: number;
  /** 占分红池的内部分配比例（0~1） */
  percentage: number;
}

export interface PayoutSplitShare extends PayoutSplitItem {
  /** 该参与人本期金额（分） */
  amountCents: number;
}

export function splitPayoutAmount(
  payoutAmountCents: number,
  items: readonly PayoutSplitItem[],
): PayoutSplitShare[] {
  if (items.length === 0) return [];
  const shares: PayoutSplitShare[] = items.map((it) => ({
    ...it,
    amountCents: Math.round(payoutAmountCents * it.percentage),
  }));
  const totalPercentage = items.reduce((sum, it) => sum + it.percentage, 0);
  const target = Math.round(payoutAmountCents * totalPercentage);
  const diff = target - shares.reduce((sum, it) => sum + it.amountCents, 0);
  if (diff !== 0) {
    let top = 0;
    for (let i = 1; i < shares.length; i++) {
      if (shares[i]!.percentage > shares[top]!.percentage) top = i;
    }
    shares[top]!.amountCents += diff;
  }
  return shares;
}
