// customers 导出 Excel（GET /api/v1/customers/export.xlsx）：
// 复用 customers.list 权限与列表同一 WHERE（软删排除 + q/customerType 筛选），
// 全量不分页；exceljs 解析校验表头与行内容。
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { channels } from "../../src/db/schema.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() }; // epoch 毫秒
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

const XLSX_URL = "/api/v1/customers/export.xlsx";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function loginAsAdmin(): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username: "admin", nickname: "管理员A" });
  const cookie = await loginAs(app, "admin", "password123");
  return { id, cookie };
}

async function createCustomer(cookie: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/customers",
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: number; nickname: string };
}

async function loadSheet(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet("客户");
  expect(ws).toBeDefined();
  return ws!;
}

describe("GET /api/v1/customers/export.xlsx", () => {
  it("未登录 → 401", async () => {
    const res = await app.inject({ method: "GET", url: XLSX_URL });
    expect(res.statusCode).toBe(401);
  });

  it("导出全量客户：xlsx 头、中文表头、行内容与展开字段", async () => {
    const { id: adminId, cookie } = await loginAsAdmin();
    const ownerId = await seedUser(tmp.db, { username: "op", nickname: "运营B" });
    const channelId = Number(
      tmp.db
        .insert(channels)
        .values({ name: "公众号主号", createdAt: clock.t, updatedAt: clock.t })
        .run().lastInsertRowid,
    );
    await createCustomer(cookie, {
      nickname: "客户甲",
      realName: "张三",
      customerType: "company",
      tagCodes: ["vip", "partner"],
      ownerIds: [ownerId],
      sourceChannelIds: [channelId],
    });
    await createCustomer(cookie, { nickname: "客户乙" });

    const res = await app.inject({ method: "GET", url: XLSX_URL, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_MIME);
    expect(res.headers["content-disposition"]).toContain("attachment");
    // zip 魔数
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");

    const ws = await loadSheet(res.rawPayload);
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1);
    expect(header).toContain("昵称");
    expect(header).toContain("归属人");
    expect(header).toContain("来源渠道");
    expect(header).toContain("标签");
    expect(ws.rowCount).toBe(3); // 表头 + 2 行

    // 找「客户甲」行（导出顺序 updatedAt desc，两行 clock 相同，按 id desc → 乙在前）
    const nickCol = header.indexOf("昵称") + 1;
    let row: ExcelJS.Row | undefined;
    ws.eachRow((r) => {
      if (r.getCell(nickCol).value === "客户甲") row = r;
    });
    expect(row).toBeDefined();
    const cellByHeader = (name: string) => row!.getCell(header.indexOf(name) + 1).value;
    expect(cellByHeader("类型")).toBe("企业");
    expect(String(cellByHeader("标签")).split("、").sort()).toEqual(["VIP", "合作伙伴"]);
    expect(cellByHeader("归属人")).toBe("运营B");
    expect(cellByHeader("来源渠道")).toBe("公众号主号");
    expect(cellByHeader("创建时间")).toBeInstanceOf(Date);
    void adminId;
  });

  it("尊重筛选：customerType 与 q 只导出匹配行；软删客户不出现", async () => {
    const { cookie } = await loginAsAdmin();
    const c1 = await createCustomer(cookie, { nickname: "企业客户", customerType: "company" });
    await createCustomer(cookie, { nickname: "普通客户", customerType: "customer" });
    await createCustomer(cookie, { nickname: "将被删除", customerType: "company" });

    // 软删第三个
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/customers?q=将被删除",
      headers: { cookie },
    });
    const delId = (list.json().data as { id: number }[])[0]!.id;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/customers/${delId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    // customerType=company → 只剩 c1
    const res = await app.inject({
      method: "GET",
      url: `${XLSX_URL}?customerType=company`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const ws = await loadSheet(res.rawPayload);
    expect(ws.rowCount).toBe(2);
    expect(ws.getRow(2).getCell(2).value ?? ws.getRow(2).getCell(1).value).toBeDefined();

    // q 过滤
    const res2 = await app.inject({
      method: "GET",
      url: `${XLSX_URL}?q=${encodeURIComponent("普通")}`,
      headers: { cookie },
    });
    expect(res2.statusCode).toBe(200);
    const ws2 = await loadSheet(res2.rawPayload);
    expect(ws2.rowCount).toBe(2);
    void c1;
  });

  it("assistant 也可导出（customers.list 放行）", async () => {
    await seedUser(tmp.db, { username: "asst", systemRole: "assistant", nickname: "助手" });
    const cookie = await loginAs(app, "asst", "password123");
    const res = await app.inject({ method: "GET", url: XLSX_URL, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_MIME);
  });
});
