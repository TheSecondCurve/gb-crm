// deal-commissions 导出 Excel（GET /api/v1/deals/commissions/export.xlsx）：
// 复用 dealCommissions.list 权限与列表同一 WHERE（日期范围/状态/q），全量不分页。
// 三个 sheet：成交明细（每笔一行）/ 参与方明细（成交×参与方长表）/ 统计（汇总+参与人小计）。
// exceljs 解析校验：原金额 → 税后基数 → 参与方比例 → 分成金额 的换算链路。
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { customers } from "../../src/db/schema.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() };
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

const XLSX_URL = "/api/v1/deals/commissions/export.xlsx";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload });
const put = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url, headers: { cookie }, payload });

let seq = 0;
async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username?: string,
): Promise<{ id: number; cookie: string }> {
  const uname = username ?? `u-${role}-${seq++}`;
  const id = await seedUser(tmp.db, { username: uname, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, uname, "password123");
  return { id, cookie };
}

function seedCustomer(db: Db, nickname: string, extra: Record<string, unknown> = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(customers)
      .values({ nickname, city: "杭州", createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

async function createDealExtra(
  cookie: string,
  extra: Record<string, unknown>,
  customerName = "客户甲",
): Promise<{ id: number }> {
  const customerId = seedCustomer(tmp.db, customerName);
  const res = await post("/api/v1/deals", cookie, {
    customerId,
    dealDate: Date.UTC(2026, 5, 15),
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: number };
}

async function loadSheet(buf: Buffer, name: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  // exceljs 的 load 声明引用旧版 @types/node 的 Buffer，与现版泛型 Buffer 不兼容，收窄断言
  await wb.xlsx.load(buf as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0]);
  const ws = wb.getWorksheet(name);
  expect(ws).toBeDefined();
  return ws!;
}

/** 从 sheet 表头反查单元格（exceljs values 1-based、slot 0 为空，先 slice 再 +1） */
function cellByHeader(ws: ExcelJS.Worksheet, row: ExcelJS.Row, header: string) {
  const headerRow = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1);
  const idx = headerRow.indexOf(header);
  expect(idx).toBeGreaterThanOrEqual(0);
  return row.getCell(idx + 1).value;
}

describe("GET /api/v1/deals/commissions/export.xlsx", () => {
  it("未登录 → 401", async () => {
    const res = await app.inject({ method: "GET", url: XLSX_URL });
    expect(res.statusCode).toBe(401);
  });

  it("导出含配置分成：xlsx 头、三 sheet、金额从原金额到分成的换算链路", async () => {
    const { cookie } = await loginAsRole("admin");
    const m1 = (await loginAsRole("operator", "m1")).id;
    const m2 = (await loginAsRole("operator", "m2")).id;
    const d = await createDealExtra(cookie, { amountCents: 100000, afterTaxRatio: 0.9 });

    const cfg = await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
      items: [
        { userId: m1, percentage: 0.06 },
        { userId: m2, percentage: 0.04 },
      ],
    });
    expect(cfg.statusCode).toBe(200);

    const res = await get(XLSX_URL, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_MIME);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");

    // —— Sheet1 成交明细（每笔一行）——
    const dealWs = await loadSheet(res.rawPayload, "成交明细");
    expect(dealWs.rowCount).toBe(2); // 表头 + 1
    const dealRow = dealWs.getRow(2);
    expect(cellByHeader(dealWs, dealRow, "客户")).toBe("客户甲");
    expect(cellByHeader(dealWs, dealRow, "成交金额(元)")).toBe(1000);
    expect(cellByHeader(dealWs, dealRow, "税后比例")).toBe(0.9);
    expect(cellByHeader(dealWs, dealRow, "税后基数(元)")).toBe(900);
    expect(cellByHeader(dealWs, dealRow, "方案")).toBe("已配置");
    expect(cellByHeader(dealWs, dealRow, "总比例")).toBe(0.1);
    expect(cellByHeader(dealWs, dealRow, "总分成(元)")).toBe(90);
    const summary = String(cellByHeader(dealWs, dealRow, "参与方明细"));
    expect(summary).toContain("6.0%");
    expect(summary).toContain("4.0%");

    // —— Sheet2 参与方明细（成交 × 参与方长表）——
    const partyWs = await loadSheet(res.rawPayload, "参与方明细");
    expect(partyWs.rowCount).toBe(3); // 表头 + 2 参与方
    const partyByUser = new Map<number, ExcelJS.Row>();
    partyWs.eachRow((r, n) => {
      if (n === 1) return;
      partyByUser.set(Number(r.getCell(8).value), r);
    });
    expect(partyByUser.get(m1)!.getCell(10).value).toBe(0.06);
    expect(partyByUser.get(m1)!.getCell(11).value).toBe(54);
    expect(partyByUser.get(m2)!.getCell(10).value).toBe(0.04);
    expect(partyByUser.get(m2)!.getCell(11).value).toBe(36);

    // —— Sheet3 统计：汇总 + 参与人小计 ——
    const statWs = await loadSheet(res.rawPayload, "统计");
    const statText = Array.from({ length: statWs.rowCount }, (_, i) => statWs.getRow(i + 1))
      .map((r) =>
        (r.values as ExcelJS.CellValue[])
          .slice(1)
          .filter((v) => v !== null && v !== undefined && v !== "")
          .join("\t"),
      )
      .join("\n");
    expect(statText).toContain("成交笔数\t1");
    expect(statText).toContain("有分成成交笔数\t1");
    expect(statText).toContain("原金额合计(元)\t1000");
    expect(statText).toContain("税后基数合计(元)\t900");
    expect(statText).toContain("总分成合计(元)\t90");
    expect(statText).toContain("参与人数(去重)\t2");
    expect(statText).toContain("昵称-operator\t1\t54\t60.0%");
    expect(statText).toContain("昵称-operator\t1\t36\t40.0%");
  });

  it("尊重筛选：日期范围只导出范围内成交；未配置套默认方案（items 空）也能导出", async () => {
    const { cookie } = await loginAsRole("admin");
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2026, 0, 31);
    await createDealExtra(cookie, { dealDate: Date.UTC(2026, 0, 15) });
    await createDealExtra(cookie, { dealDate: Date.UTC(2026, 5, 15) });

    const res = await get(`${XLSX_URL}?startDate=${start}&endDate=${end}`, cookie);
    expect(res.statusCode).toBe(200);
    const dealWs = await loadSheet(res.rawPayload, "成交明细");
    expect(dealWs.rowCount).toBe(2); // 只 1 条在范围内
    // 未配置 → 方案=默认、参与方明细空
    expect(cellByHeader(dealWs, dealWs.getRow(2), "方案")).toBe("默认");
    expect(cellByHeader(dealWs, dealWs.getRow(2), "参与方明细")).toBe("");
  });

  it("assistant 也可导出（dealCommissions.list 放行）", async () => {
    const { cookie } = await loginAsRole("assistant");
    const res = await get(XLSX_URL, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_MIME);
  });
});
