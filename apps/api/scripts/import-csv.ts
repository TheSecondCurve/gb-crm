// CSV 回退路径（Alternative H）：从目录读四张中文列头的 CSV，归一成 FeishuDump。
// 约定（脱敏 fixture 与手工整理的真实导出共用）：
// - 必须有 record_id 列（真实飞书 CSV 导出没有 record id，需先补上，否则行被 skipped）；
// - 空单元格 → 缺省；多值单元格（link / 客户标签）以「;」分隔；
// - 数字/日期列直接写数字（日期为 epoch ms）。
import fs from "node:fs";
import path from "node:path";

import type { FeishuDump, FeishuRecord } from "./import-core.js";

/** RFC 4180 迷你解析器：支持引号转义（""）与 CRLF；不依赖第三方包。 */
export function parseCsv(content: string): string[][] {
  const input = content.replace(/^\uFEFF/, ""); // 去 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV 文本 → FeishuRecord[]：首行是中文列头（含 record_id），空单元格键缺席。 */
export function csvToRecords(content: string): FeishuRecord[] {
  const rows = parseCsv(content);
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  const recordIdIdx = header.indexOf("record_id");
  if (recordIdIdx === -1) {
    throw new Error("CSV 缺少 record_id 列（导入需要 feishu record id 才能幂等 UPSERT）");
  }
  const records: FeishuRecord[] = [];
  for (const row of rows.slice(1)) {
    const recordId = (row[recordIdIdx] ?? "").trim();
    const fields: Record<string, unknown> = {};
    header.forEach((name, idx) => {
      if (name === "record_id" || name === "") return;
      const value = (row[idx] ?? "").trim();
      if (value !== "") fields[name] = value;
    });
    records.push({ recordId, fields });
  }
  return records;
}

const CSV_FILES: { key: keyof FeishuDump; file: string }[] = [
  { key: "users", file: "团队成员.csv" },
  { key: "channels", file: "渠道资产.csv" },
  { key: "products", file: "产品目录.csv" },
  { key: "customers", file: "客户名单.csv" },
];

/** 读目录下 团队成员.csv / 渠道资产.csv / 产品目录.csv / 客户名单.csv（中文列头）。 */
export function loadCsvDump(dir: string): FeishuDump {
  const dump = { users: [], channels: [], products: [], customers: [] } as FeishuDump;
  for (const { key, file } of CSV_FILES) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`CSV 回退目录缺少文件：${filePath}`);
    }
    dump[key] = csvToRecords(fs.readFileSync(filePath, "utf8"));
  }
  return dump;
}
