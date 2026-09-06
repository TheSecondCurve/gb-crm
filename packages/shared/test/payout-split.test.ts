// splitPayoutAmount：payout 期金额 × 内部分配比例的逐人拆分（K56 v2 导出/预览共用推导）。
// 不变量：Σ每人 = round(期金额 × Σ比例)；逐人四舍五入的尾差兜底给比例最大的人（并列取首个）。
import { describe, expect, it } from "vitest";

import { splitPayoutAmount } from "../src/payout-split.js";

describe("splitPayoutAmount", () => {
  it("空参与方 → 空数组", () => {
    expect(splitPayoutAmount(4500, [])).toEqual([]);
  });

  it("单人 100%：全额归一人", () => {
    expect(splitPayoutAmount(2044, [{ userId: 1, percentage: 1 }])).toEqual([
      { userId: 1, percentage: 1, amountCents: 2044 },
    ]);
  });

  it("80/20 整除：无尾差", () => {
    expect(
      splitPayoutAmount(22327, [
        { userId: 3, percentage: 0.8 },
        { userId: 12, percentage: 0.2 },
      ]),
    ).toEqual([
      { userId: 3, percentage: 0.8, amountCents: 17862 },
      { userId: 12, percentage: 0.2, amountCents: 4465 },
    ]);
  });

  it("Σ比例 < 1：按各自比例分，总额 = round(期金额 × Σ比例)", () => {
    expect(
      splitPayoutAmount(4500, [
        { userId: 1, percentage: 0.06 },
        { userId: 2, percentage: 0.04 },
      ]),
    ).toEqual([
      { userId: 1, percentage: 0.06, amountCents: 270 },
      { userId: 2, percentage: 0.04, amountCents: 180 },
    ]);
  });

  it("尾差兜底：101 分 50/50 → 差额 -1 记到首个最大份额人", () => {
    const shares = splitPayoutAmount(101, [
      { userId: 1, percentage: 0.5 },
      { userId: 2, percentage: 0.5 },
    ]);
    expect(shares).toEqual([
      { userId: 1, percentage: 0.5, amountCents: 50 },
      { userId: 2, percentage: 0.5, amountCents: 51 },
    ]);
    expect(shares.reduce((s, x) => s + x.amountCents, 0)).toBe(101);
  });

  it("尾差兜底给比例最大者（非首个）：101 分 33/33/34", () => {
    const shares = splitPayoutAmount(101, [
      { userId: 1, percentage: 0.33 },
      { userId: 2, percentage: 0.33 },
      { userId: 3, percentage: 0.34 },
    ]);
    expect(shares.map((s) => s.amountCents)).toEqual([33, 33, 35]);
    expect(shares.reduce((s, x) => s + x.amountCents, 0)).toBe(101);
  });
});
