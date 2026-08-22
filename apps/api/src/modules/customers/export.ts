// customers 导出 xlsx 组装（不写 SQL；输入为 assemble 后的 CustomerDto）。
// 列与 apps/web/src/columns/customers.tsx 的 label 对齐；枚举 code → 中文 label
// 用 shared 的 customerTypeLabels / tagLabels；时间戳写 Date 单元格 + numFmt。
import ExcelJS from "exceljs";

import { customerTypeLabels, tagLabels, type CustomerType, type Tag } from "@gb-crm/shared";

import type { CustomerDto } from "./assemble.js";

const DATE_FMT = "yyyy-mm-dd hh:mm";
const joinNames = (refs: readonly { nickname?: string; name?: string }[]): string =>
  refs.map((r) => r.nickname ?? r.name ?? "").join("、");

interface ColumnDef {
  header: string;
  width: number;
  value: (row: CustomerDto) => string | number | Date | null;
  numFmt?: string;
}

const dateCol = (header: string, get: (row: CustomerDto) => number | null): ColumnDef => ({
  header,
  width: 18,
  value: (row) => {
    const ts = get(row);
    return ts === null ? null : new Date(ts);
  },
  numFmt: DATE_FMT,
});

const COLUMNS: ColumnDef[] = [
  { header: "ID", width: 8, value: (r) => r.id },
  { header: "昵称", width: 16, value: (r) => r.nickname },
  { header: "真实姓名", width: 12, value: (r) => r.realName },
  { header: "称谓", width: 10, value: (r) => r.title },
  { header: "手机号", width: 14, value: (r) => r.phone },
  { header: "微信号", width: 16, value: (r) => r.wechat },
  {
    header: "类型",
    width: 10,
    value: (r) => customerTypeLabels[r.customerType as CustomerType] ?? r.customerType,
  },
  {
    header: "标签",
    width: 20,
    value: (r) => r.tagCodes.map((t) => tagLabels[t as Tag] ?? t).join("、"),
  },
  { header: "国家", width: 10, value: (r) => r.country },
  { header: "城市", width: 10, value: (r) => r.city },
  { header: "元故事", width: 30, value: (r) => r.originStory },
  { header: "备注", width: 30, value: (r) => r.notes },
  { header: "档案页", width: 24, value: (r) => r.profileUrl },
  { header: "父记录", width: 16, value: (r) => r.parent?.nickname ?? null },
  { header: "OpenID", width: 20, value: (r) => r.wechatOpenid },
  dateCol("最近跟进", (r) => r.lastFollowedAt),
  { header: "视频号账号", width: 16, value: (r) => r.wechatChannelsAccount },
  { header: "小宇宙账号", width: 16, value: (r) => r.xiaoyuzhouAccount },
  { header: "小红书账号", width: 16, value: (r) => r.xiaohongshuAccount },
  { header: "微博账号", width: 16, value: (r) => r.weiboAccount },
  { header: "抖音账号", width: 16, value: (r) => r.douyinAccount },
  { header: "其他社交账号", width: 16, value: (r) => r.otherSocial },
  { header: "来源渠道", width: 20, value: (r) => joinNames(r.sourceChannels) },
  { header: "所在社群", width: 20, value: (r) => joinNames(r.communityChannels) },
  { header: "归属人", width: 14, value: (r) => joinNames(r.owners) },
  { header: "升单人", width: 14, value: (r) => joinNames(r.upsellOwners) },
  { header: "飞书记录", width: 20, value: (r) => r.feishuRecordId },
  dateCol("创建时间", (r) => r.createdAt),
  dateCol("更新时间", (r) => r.updatedAt),
  { header: "创建人", width: 12, value: (r) => r.createdBy?.nickname ?? null },
  { header: "最后修改人", width: 12, value: (r) => r.updatedBy?.nickname ?? null },
];

/** 客户列表 → xlsx Buffer（单 worksheet「客户」） */
export async function buildCustomersXlsx(rows: readonly CustomerDto[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("客户");
  sheet.columns = COLUMNS.map(({ header, width }) => ({ header, width }));

  for (const row of rows) {
    const excelRow = sheet.addRow(COLUMNS.map((c) => c.value(row)));
    COLUMNS.forEach((c, i) => {
      if (c.numFmt) excelRow.getCell(i + 1).numFmt = c.numFmt;
    });
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}
