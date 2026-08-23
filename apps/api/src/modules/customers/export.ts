// customers 导出 xlsx 组装（不写 SQL；输入为 assemble 后的 CustomerDto）。
// 列与 apps/web/src/columns/customers.tsx 的 label 对齐；枚举 code → 中文 label
// 用 shared 的 customerTypeLabels；时间戳写 Date 单元格 + numFmt。
// fields 选列（圈子工作台按用户所选字段导出）：key 与 web 字段选择器对齐，
// 缺省/空 = 全列；列顺序始终按本文件定义，不跟随传入顺序。
import ExcelJS from "exceljs";

import { customerTypeLabels, type CustomerType } from "@gb-crm/shared";

import type { CustomerDto } from "./assemble.js";

const DATE_FMT = "yyyy-mm-dd hh:mm";
const joinNames = (refs: readonly { nickname?: string; name?: string }[]): string =>
  refs.map((r) => r.nickname ?? r.name ?? "").join("、");

interface ColumnDef {
  /** 机器可读 key（= web 字段选择器 / ?fields= 参数值） */
  key: string;
  header: string;
  width: number;
  value: (row: CustomerDto) => string | number | Date | null;
  numFmt?: string;
}

const dateCol = (key: string, header: string, get: (row: CustomerDto) => number | null): ColumnDef => ({
  key,
  header,
  width: 18,
  value: (row) => {
    const ts = get(row);
    return ts === null ? null : new Date(ts);
  },
  numFmt: DATE_FMT,
});

const COLUMNS: ColumnDef[] = [
  { key: "id", header: "ID", width: 8, value: (r) => r.id },
  { key: "nickname", header: "昵称", width: 16, value: (r) => r.nickname },
  { key: "realName", header: "真实姓名", width: 12, value: (r) => r.realName },
  { key: "title", header: "称谓", width: 10, value: (r) => r.title },
  { key: "phone", header: "手机号", width: 14, value: (r) => r.phone },
  { key: "wechat", header: "微信号", width: 16, value: (r) => r.wechat },
  {
    key: "customerType",
    header: "类型",
    width: 10,
    value: (r) => customerTypeLabels[r.customerType as CustomerType] ?? r.customerType,
  },
  { key: "country", header: "国家", width: 10, value: (r) => r.country },
  { key: "city", header: "城市", width: 10, value: (r) => r.city },
  { key: "industry", header: "行业", width: 14, value: (r) => r.industry },
  { key: "tags", header: "标签", width: 24, value: (r) => r.tags.map((t) => t.name).join("、") },
  { key: "originStory", header: "元故事", width: 30, value: (r) => r.originStory },
  { key: "notes", header: "备注", width: 30, value: (r) => r.notes },
  { key: "wechatOpenid", header: "OpenID", width: 20, value: (r) => r.wechatOpenid },
  dateCol("lastFollowedAt", "最近跟进", (r) => r.lastFollowedAt),
  { key: "sourceChannels", header: "来源渠道", width: 20, value: (r) => joinNames(r.sourceChannels) },
  { key: "owner", header: "归属人", width: 14, value: (r) => r.owner?.nickname ?? null },
  dateCol("createdAt", "创建时间", (r) => r.createdAt),
  dateCol("updatedAt", "更新时间", (r) => r.updatedAt),
  { key: "createdBy", header: "创建人", width: 12, value: (r) => r.createdBy?.nickname ?? null },
  { key: "updatedBy", header: "最后修改人", width: 12, value: (r) => r.updatedBy?.nickname ?? null },
];

/** 全部可选导出字段 key（web 圈子工作台字段选择器据此对齐；校验 ?fields= 用） */
export const CUSTOMER_EXPORT_KEYS: string[] = COLUMNS.map((c) => c.key);

/** 客户列表 → xlsx Buffer（单 worksheet「客户」）；fields 为空/缺省 = 全列 */
export async function buildCustomersXlsx(
  rows: readonly CustomerDto[],
  fields?: readonly string[],
): Promise<Buffer> {
  const columns =
    fields && fields.length > 0 ? COLUMNS.filter((c) => fields.includes(c.key)) : COLUMNS;
  if (columns.length === 0) return Buffer.from(await new ExcelJS.Workbook().xlsx.writeBuffer());

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("客户");
  sheet.columns = columns.map(({ header, width }) => ({ header, width }));

  for (const row of rows) {
    const excelRow = sheet.addRow(columns.map((c) => c.value(row)));
    columns.forEach((c, i) => {
      if (c.numFmt) excelRow.getCell(i + 1).numFmt = c.numFmt;
    });
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
