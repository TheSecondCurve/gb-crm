// deal-commissions 导出 xlsx（K56）：以「成交」为粒度，覆盖 原金额→税后比例→税后基数→参与方比例→分成金额 全链路。
// 三个 sheet：
//   1)「成交明细」：每笔成交一行，所有参与方合并进「参与方明细」文本列；
//   2)「参与方明细」：每笔成交 × 每个参与方一行（长表，供 Excel pivot/透视求和）；
//   3)「统计」：范围内汇总（成交笔数/原金额合计/税后基数合计/总分成合计/去重参与人数）+ 按参与人小计。
// 金额一律 分 → 元（÷100）；时间戳写 Date 单元格 + numFmt。与 customers/export.ts 同风格（exceljs，零新依赖）。
import ExcelJS from "exceljs";

import type { DealCommissionDto } from "./assemble.js";

const DATE_FMT = "yyyy-mm-dd hh:mm";

const yuan = (cents: number | null): number | null => (cents === null ? null : cents / 100);

const percentText = (p: number): string => `${(p * 100).toFixed(1)}%`;

/** 金额文本（分 → ¥xx.xx）；null → — */
const moneyText = (cents: number | null): string =>
  cents === null ? "—" : `¥${(cents / 100).toFixed(2)}`;

/** 单个参与方文本：「昵称 30.0%(¥1,800.00)」（nickname 缺失回落 #id） */
function itemText(it: DealCommissionDto["items"][number]): string {
  const name = it.nickname ?? `#${it.userId}`;
  return `${name} ${percentText(it.percentage)}(${moneyText(it.amountCents)})`;
}

/** 负责人分成文本：按 deals.owner_id 在明细里找对应人的 比例(金额)；负责人未参与 → — */
function ownerSplitText(row: DealCommissionDto): string {
  const item = row.items.find((it) => it.userId === row.owner?.id);
  return item ? `${percentText(item.percentage)}(${moneyText(item.amountCents)})` : "—";
}

/** 其他参与方（除负责人）文本：昵称 比例(金额)、…；空 → — */
function otherParticipantsText(row: DealCommissionDto): string {
  const others = row.items.filter((it) => it.userId !== row.owner?.id);
  return others.length === 0 ? "—" : others.map(itemText).join("、");
}

/** payout 文本：「#1 2026-08 50.0%(¥90.00 待发)、…」；空 → — */
function payoutsText(row: DealCommissionDto): string {
  return row.payouts.length === 0
    ? "—"
    : row.payouts
        .map(
          (p) =>
            `#${p.seq} ${formatEpochDay(p.payoutDate)} ${percentText(p.rate)}(${moneyText(p.amountCents)} ${p.status === "paid" ? "已发" : "待发"})`,
        )
        .join("、");
}

interface ColumnDef {
  header: string;
  width: number;
  value: (row: DealCommissionDto) => string | number | Date | null;
  numFmt?: string;
}

const dateCol = (header: string, get: (row: DealCommissionDto) => number | null): ColumnDef => ({
  header,
  width: 18,
  value: (row) => {
    const ts = get(row);
    return ts === null ? null : new Date(ts);
  },
  numFmt: DATE_FMT,
});

// Sheet1「成交明细」列（每笔成交一行）
const DEAL_COLUMNS: ColumnDef[] = [
  { header: "成交ID", width: 8, value: (r) => r.dealId },
  { header: "客户", width: 16, value: (r) => r.customer?.nickname ?? null },
  { header: "成交归属人", width: 12, value: (r) => r.customerOwner?.nickname ?? null },
  { header: "成交产品", width: 16, value: (r) => r.product?.name ?? null },
  dateCol("成交日期", (r) => r.dealDate),
  dateCol("交付日期", (r) => r.deliveryDate),
  { header: "负责人", width: 12, value: (r) => r.owner?.nickname ?? null },
  { header: "订单号", width: 16, value: (r) => r.orderNo },
  { header: "成交金额(元)", width: 14, value: (r) => yuan(r.amountCents) },
  { header: "税后比例", width: 10, value: (r) => r.afterTaxRatio },
  { header: "税后基数(元)", width: 14, value: (r) => yuan(r.baseAmountCents) },
  { header: "总比例", width: 10, value: (r) => r.totalRatio },
  { header: "分红池(元)", width: 14, value: (r) => yuan(r.poolAmountCents) },
  { header: "负责人分成", width: 22, value: (r) => ownerSplitText(r) },
  { header: "其他参与方", width: 46, value: (r) => otherParticipantsText(r) },
  { header: "内部分配比例", width: 12, value: (r) => r.totalPercentage },
  { header: "总分成(元)", width: 14, value: (r) => yuan(r.totalAmountCents) },
  { header: "payout", width: 34, value: (r) => payoutsText(r) },
  { header: "方案", width: 8, value: (r) => (r.isCustomized ? "已配置" : "默认") },
];

const formatEpochDay = (ms: number | null | undefined): string => {
  if (ms == null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function rangeText(start?: number | null, end?: number | null): string {
  if (start == null && end == null) return "全部";
  if (start != null && end != null) return `${formatEpochDay(start)} ~ ${formatEpochDay(end)}`;
  if (start != null) return `${formatEpochDay(start)} 之后`;
  return `${formatEpochDay(end)} 之前`;
}

export async function buildCommissionXlsx(
  rows: readonly DealCommissionDto[],
  range?: { start?: number | null; end?: number | null },
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  // Sheet1「成交明细」：每笔成交一行
  const dealSheet = workbook.addWorksheet("成交明细");
  dealSheet.columns = DEAL_COLUMNS.map(({ header, width }) => ({ header, width }));
  for (const row of rows) {
    const excelRow = dealSheet.addRow(DEAL_COLUMNS.map((c) => c.value(row)));
    DEAL_COLUMNS.forEach((c, i) => {
      if (c.numFmt) excelRow.getCell(i + 1).numFmt = c.numFmt;
    });
  }
  dealSheet.getRow(1).font = { bold: true };
  dealSheet.views = [{ state: "frozen", ySplit: 1 }];

  // Sheet2「参与方明细」：每笔成交 × 每参与方一行（长表）
  const partySheet = workbook.addWorksheet("参与方明细");
  partySheet.columns = [
    { header: "成交ID", width: 8 },
    { header: "客户", width: 16 },
    { header: "成交归属人", width: 12 },
    { header: "成交产品", width: 16 },
    { header: "成交日期", width: 18 },
    { header: "交付日期", width: 18 },
    { header: "负责人", width: 12 },
    { header: "订单号", width: 16 },
    { header: "成交金额(元)", width: 14 },
    { header: "税后比例", width: 10 },
    { header: "税后基数(元)", width: 14 },
    { header: "参与人ID", width: 10 },
    { header: "参与人", width: 14 },
    { header: "是否负责人", width: 10 },
    { header: "比例", width: 10 },
    { header: "分成金额(元)", width: 14 },
  ];
  for (const row of rows) {
    for (const item of row.items) {
      const excelRow = partySheet.addRow([
        row.dealId,
        row.customer?.nickname ?? null,
        row.customerOwner?.nickname ?? null,
        row.product?.name ?? null,
        new Date(row.dealDate),
        row.deliveryDate === null ? null : new Date(row.deliveryDate),
        row.owner?.nickname ?? null,
        row.orderNo,
        yuan(row.amountCents),
        row.afterTaxRatio,
        yuan(row.baseAmountCents),
        item.userId,
        item.nickname ?? `#${item.userId}`,
        item.userId === row.owner?.id ? "是" : "否",
        item.percentage,
        yuan(item.amountCents),
      ]);
      excelRow.getCell(5).numFmt = DATE_FMT;
      if (row.deliveryDate !== null) excelRow.getCell(6).numFmt = DATE_FMT;
    }
  }
  partySheet.getRow(1).font = { bold: true };
  partySheet.views = [{ state: "frozen", ySplit: 1 }];

  // Sheet3「统计」：范围内汇总 + 按参与人小计
  const statSheet = workbook.addWorksheet("统计");
  const dealCount = rows.length;
  const withCommissions = rows.filter((r) => r.items.length > 0).length;
  const sumAmount = sumNonNull(rows.map((r) => r.amountCents));
  const sumBase = sumNonNull(rows.map((r) => r.baseAmountCents));
  const sumTotal = sumNonNull(rows.map((r) => r.totalAmountCents));

  // 按参与人聚合（一成交一人一行，同一成交内 userId 唯一）
  const byUser = new Map<number, { name: string; dealCount: number; amount: number }>();
  for (const row of rows) {
    for (const item of row.items) {
      const entry = byUser.get(item.userId) ?? {
        name: item.nickname ?? `#${item.userId}`,
        dealCount: 0,
        amount: 0,
      };
      entry.dealCount += 1;
      entry.amount += item.amountCents ?? 0;
      byUser.set(item.userId, entry);
    }
  }

  statSheet.addRow(["成交分成统计"]);
  statSheet.getRow(1).font = { bold: true };
  statSheet.addRow(["数据范围", rangeText(range?.start, range?.end)]);
  statSheet.addRow(["成交笔数", dealCount]);
  statSheet.addRow(["有分成成交笔数", withCommissions]);
  statSheet.addRow(["原金额合计(元)", yuan(sumAmount)]);
  statSheet.addRow(["税后基数合计(元)", yuan(sumBase)]);
  statSheet.addRow(["总分成合计(元)", yuan(sumTotal)]);
  statSheet.addRow(["参与人数(去重)", byUser.size]);
  statSheet.addRow([]);

  statSheet.addRow(["参与人小计"]);
  statSheet.getRow(statSheet.rowCount).font = { bold: true };
  statSheet.addRow(["参与人", "成交笔数", "分成金额合计(元)", "占总分成比"]);
  const pivotRows = [...byUser.values()].sort((a, b) => b.amount - a.amount);
  for (const p of pivotRows) {
    statSheet.addRow([
      p.name,
      p.dealCount,
      yuan(p.amount),
      sumTotal === null || sumTotal === 0 ? "—" : `${((p.amount / sumTotal) * 100).toFixed(1)}%`,
    ]);
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

function sumNonNull(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v !== null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}
