// deal-commissions（K56）：成交分红管理——默认方案推导 / 自定义配置 / 兜底校验 / RBAC。
// inject + loginAs，假时钟控 updatedAt；默认方案走 system_configs（PATCH /system/commission-default）。
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

type JsonBody = Record<string, unknown>;

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const put = (url: string, cookie: string, payload: JsonBody) =>
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

function seedCustomer(db: Db, nickname: string, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(customers)
      .values({ nickname, city: "杭州", createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

/** 建一笔成交（API，admin），可选金额/负责人/交付日期 */
async function createDealAsAdmin(extra: JsonBody = {}): Promise<{
  cookie: string;
  data: { id: number; customerId: number; amountCents: number | null; afterTaxRatio: number | null; updatedAt: number };
  customerId: number;
}> {
  const { cookie } = await loginAsRole("admin");
  const customerId = seedCustomer(tmp.db, "客户甲");
  const res = await post("/api/v1/deals", cookie, { customerId, ...extra });
  expect(res.statusCode).toBe(201);
  return { cookie, data: res.json().data, customerId };
}

describe("RBAC（dealCommissions 资源，K56）", () => {
  it("assistant：list/read 200；update → 403", async () => {
    const { data: d } = await createDealAsAdmin();
    const { cookie: aCookie } = await loginAsRole("assistant");

    expect((await get("/api/v1/deals/commissions", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/deals/${d.id}/commissions`, aCookie)).statusCode).toBe(200);
    expect((await put(`/api/v1/deals/${d.id}/commissions`, aCookie, { items: [] })).statusCode).toBe(403);
    expect((await get("/api/v1/system/commission-default", aCookie)).statusCode).toBe(403); // system 仅 admin
  });

  it("operator：update → 200；admin：update → 200", async () => {
    const { data: d } = await createDealAsAdmin();
    const { id: memberId } = await loginAsRole("operator", "member-1");
    for (const role of ["operator", "admin"] as const) {
      const { cookie } = await loginAsRole(role, `u-${role}-x`);
      const res = await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
        items: [{ userId: memberId, percentage: 0.1 }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.isCustomized).toBe(true);
    }
  });
});

describe("默认方案（system_configs commissionDefault）", () => {
  it("无默认方案 → 未配置成交 items 为空、total 0、isCustomized=false", async () => {
    const { cookie } = await loginAsRole("admin");
    const { data: d } = await createDealAsAdmin({ amountCents: 100000, afterTaxRatio: 0.9 });
    const res = await get(`/api/v1/deals/${d.id}/commissions`, cookie);
    expect(res.statusCode).toBe(200);
    const c = res.json().data;
    expect(c.isCustomized).toBe(false);
    expect(c.items).toEqual([]);
    expect(c.totalPercentage).toBe(0);
    expect(c.baseAmountCents).toBe(90000);
  });

  it("配置默认方案（归属人/负责人/指定人）→ 未配置成交自动推导并算钱", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: ownerId } = await loginAsRole("operator", "owner-归属人");
    const { id: dealOwnerId } = await loginAsRole("operator", "owner-负责人");
    const { id: helperId } = await loginAsRole("operator", "helper-助手");

    // 客户归属人 = ownerId；成交负责人 = dealOwnerId
    const customerId = seedCustomer(tmp.db, "客户A", { ownerId });
    const deal = await post("/api/v1/deals", cookie, {
      customerId,
      ownerId: dealOwnerId,
      amountCents: 100000,
      afterTaxRatio: 0.9,
    });
    const d = deal.json().data;

    const patchDefault = await patch("/api/v1/system/commission-default", cookie, {
      rules: [
        { source: "owner", percentage: 0.02 },
        { source: "dealOwner", percentage: 0.04 },
        { source: "user", userId: helperId, percentage: 0.04 },
      ],
    });
    expect(patchDefault.statusCode).toBe(200);

    const res = await get(`/api/v1/deals/${d.id}/commissions`, cookie);
    expect(res.statusCode).toBe(200);
    const c = res.json().data;
    expect(c.isCustomized).toBe(false);
    expect(c.totalPercentage).toBe(0.1);
    expect(c.baseAmountCents).toBe(90000);
    expect(c.items).toEqual([
      { userId: ownerId, nickname: "昵称-operator", percentage: 0.02, amountCents: 1800 },
      { userId: dealOwnerId, nickname: "昵称-operator", percentage: 0.04, amountCents: 3600 },
      { userId: helperId, nickname: "昵称-operator", percentage: 0.04, amountCents: 3600 },
    ]);
    expect(c.totalAmountCents).toBe(9000);
  });

  it("默认方案校验：user 规则缺 userId → 422；Σ>1 → 422；user 不存在 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect(
      (
        await patch("/api/v1/system/commission-default", cookie, {
          rules: [{ source: "user", percentage: 0.1 }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await patch("/api/v1/system/commission-default", cookie, {
          rules: [
            { source: "owner", percentage: 0.6 },
            { source: "dealOwner", percentage: 0.6 },
          ],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await patch("/api/v1/system/commission-default", cookie, {
          rules: [{ source: "user", userId: 9999, percentage: 0.1 }],
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe("自定义配置 PUT /deals/:id/commissions", () => {
  it("配置后 isCustomized=true；items 覆盖默认方案；GET list 状态可筛", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: m1 } = await loginAsRole("operator", "m1");
    const { id: m2 } = await loginAsRole("operator", "m2");
    const { data: d } = await createDealAsAdmin({ amountCents: 100000, afterTaxRatio: 0.9 });

    const res = await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
      items: [
        { userId: m1, percentage: 0.06 },
        { userId: m2, percentage: 0.04 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const c = res.json().data;
    expect(c.isCustomized).toBe(true);
    expect(c.totalPercentage).toBe(0.1);
    expect(c.items.map((i: { userId: number }) => i.userId)).toEqual([m1, m2]);
    expect(c.totalAmountCents).toBe(9000);

    // 状态筛选：custom 1 条、default 0 条
    const custom = await get("/api/v1/deals/commissions?status=custom", cookie);
    expect(custom.json().meta.total).toBe(1);
    const def = await get("/api/v1/deals/commissions?status=default", cookie);
    expect(def.json().meta.total).toBe(0);
  });

  it("还原默认：PUT [] → 删除配置行、isCustomized=false；再配另一人覆盖", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: m1 } = await loginAsRole("operator", "m1-revert");
    const { data: d } = await createDealAsAdmin();

    await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
      items: [{ userId: m1, percentage: 0.1 }],
    });
    let row = await get(`/api/v1/deals/commissions?status=custom`, cookie);
    expect(row.json().meta.total).toBe(1);

    const revert = await put(`/api/v1/deals/${d.id}/commissions`, cookie, { items: [] });
    expect(revert.json().data.isCustomized).toBe(false);
    row = await get("/api/v1/deals/commissions?status=custom", cookie);
    expect(row.json().meta.total).toBe(0);
    // 库中配置行已删
    const dbc = tmp.sqlite.prepare("SELECT COUNT(*) n FROM deal_commissions WHERE deal_id = ?").get(d.id) as { n: number };
    expect(dbc.n).toBe(0);
  });

  it("校验：Σ>1 → 422；重复 userId → 422；userId 不存在/软删 → 422；成交不存在 → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: m1 } = await loginAsRole("operator", "m1-validate");
    const { data: d } = await createDealAsAdmin();

    expect(
      (
        await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
          items: [
            { userId: m1, percentage: 0.6 },
            { userId: (await loginAsRole("operator", "m1b")).id, percentage: 0.6 },
          ],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
          items: [
            { userId: m1, percentage: 0.1 },
            { userId: m1, percentage: 0.2 },
          ],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await put(`/api/v1/deals/${d.id}/commissions`, cookie, { items: [{ userId: 9999, percentage: 0.1 }] }))
        .statusCode,
    ).toBe(422);

    // 软删用户 → 422
    const { id: dying } = await loginAsRole("operator", "dying");
    tmp.sqlite.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").run(clock.t, dying);
    expect(
      (await put(`/api/v1/deals/${d.id}/commissions`, cookie, { items: [{ userId: dying, percentage: 0.1 }] }))
        .statusCode,
    ).toBe(422);

    expect((await put("/api/v1/deals/9999/commissions", cookie, { items: [] })).statusCode).toBe(404);
  });
});

describe("列表：日期范围与搜索", () => {
  it("按成交日期（deliveryDate，缺省回落 createdAt）范围筛选", async () => {
    const { cookie } = await loginAsRole("admin");
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2026, 0, 31);
    await createDealAsAdmin({ deliveryDate: Date.UTC(2026, 0, 15) });
    await createDealAsAdmin({ deliveryDate: Date.UTC(2026, 5, 15) });
    await createDealAsAdmin({ orderNo: "ORD-SEARCH" }); // 无 deliveryDate，回落 createdAt

    const inRange = await get(`/api/v1/deals/commissions?startDate=${start}&endDate=${end}`, cookie);
    expect(inRange.json().meta.total).toBe(1);

    const all = await get("/api/v1/deals/commissions", cookie);
    expect(all.json().meta.total).toBe(3);

    const byQ = await get("/api/v1/deals/commissions?q=" + encodeURIComponent("ORD-SEARCH"), cookie);
    expect(byQ.json().meta.total).toBe(1);
  });
});
