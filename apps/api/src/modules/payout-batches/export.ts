// payout-batches 导出 xlsx（K59）：以「批次明细」为粒度。
// 两个 sheet：
//   1)「发放汇总」：每参与人一行（昵称 + 合计金额(元)）+ 参与人×成交月份 pivot 区（每月一列）+ 总计行；
//   2)「发放明细」：明细 × 参与人长表（批次名/成交日期/成交月份/产品/客户/成交负责人/客户归属人/
//      期次/payout 日期/比例/期金额(元)/参与人/分摊金额(元)）。
// draft 批次用实时值、locked/paid 用锁定快照（由 service 的详情 DTO 决定，本模块不感知）。
// 金额一律 分 → 元（÷100）；日期单元格走 excelDate（上海墙钟），禁止裸 new Date。
import ExcelJS from "exceljs";

import { excelDate } from "../../lib/excel-date.js";

import type { PayoutBatchDetailDto } from "./assemble.js";

const DATE_FMT = "yyyy-mm-dd";

const yuan = (cents: number | null): number | null => (cents === null ? null : cents / 100);

export async function buildPayoutBatchXlsx(detail: PayoutBatchDetailDto): Promise<Buffer> {
  const { batch, items, summary } = detail;
  const workbook = new ExcelJS.Workbook();

  // Sheet1「发放汇总」：参与人一行 + 参与人×成交月份 pivot + 总计行
  const months = [...new Set(summary.flatMap((s) => s.byMonth.map((m) => m.month)))].sort();
  const summarySheet = workbook.addWorksheet("发放汇总");
  summarySheet.columns = [
    { header: "参与人", width: 16 },
    { header: "合计金额(元)", width: 14 },
    ...months.map((m) => ({ header: `${m}(元)`, width: 12 })),
  ];
  for (const s of summary) {
    summarySheet.addRow([
      s.nickname ?? `#${s.userId}`,
      s.totalAmountCents / 100,
      ...months.map((m) => (s.byMonth.find((x) => x.month === m)?.amountCents ?? 0) / 100),
    ]);
  }
  const totalRow = summarySheet.addRow([
    "总计",
    summary.reduce((sum, s) => sum + s.totalAmountCents, 0) / 100,
    ...months.map(
      (m) =>
        summary.reduce(
          (sum, s) => sum + (s.byMonth.find((x) => x.month === m)?.amountCents ?? 0),
          0,
        ) / 100,
    ),
  ]);
  totalRow.font = { bold: true };
  summarySheet.getRow(1).font = { bold: true };
  summarySheet.views = [{ state: "frozen", ySplit: 1 }];

  // Sheet2「发放明细」：明细 × 参与人长表（无参与人的明细也出一行，参与人/分摊金额留空）
  const detailSheet = workbook.addWorksheet("发放明细");
  detailSheet.columns = [
    { header: "批次名", width: 24 },
    { header: "成交ID", width: 8 },
    { header: "成交日期", width: 14 },
    { header: "成交月份", width: 10 },
    { header: "产品", width: 16 },
    { header: "客户", width: 16 },
    { header: "成交负责人", width: 12 },
    { header: "客户归属人", width: 12 },
    { header: "期次", width: 6 },
    { header: "payout 日期", width: 14 },
    { header: "比例", width: 10 },
    { header: "期金额(元)", width: 12 },
    { header: "payout 状态", width: 10 },
    { header: "参与人", width: 14 },
    { header: "分摊金额(元)", width: 14 },
  ];
  const statusText = { pending: "待发", paid: "已发", missing: "已失效" } as const;
  for (const item of items) {
    const base = [
      batch.name,
      item.dealId,
      excelDate(item.dealDate),
      item.dealMonth,
      item.product?.name ?? null,
      item.customer?.nickname ?? null,
      item.owner?.nickname ?? null,
      item.customerOwner?.nickname ?? null,
      item.seq,
      item.payoutDate === null ? null : excelDate(item.payoutDate),
      item.rate,
      yuan(item.payoutAmountCents),
      statusText[item.payoutStatus],
    ] as const;
    if (item.shares.length === 0) {
      const excelRow = detailSheet.addRow([...base, null, null]);
      excelRow.getCell(3).numFmt = DATE_FMT;
      if (item.payoutDate !== null) excelRow.getCell(10).numFmt = DATE_FMT;
      continue;
    }
    for (const share of item.shares) {
      const excelRow = detailSheet.addRow([
        ...base,
        share.nickname ?? `#${share.userId}`,
        yuan(share.amountCents),
      ]);
      excelRow.getCell(3).numFmt = DATE_FMT;
      if (item.payoutDate !== null) excelRow.getCell(10).numFmt = DATE_FMT;
    }
  }
  detailSheet.getRow(1).font = { bold: true };
  detailSheet.views = [{ state: "frozen", ySplit: 1 }];

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
