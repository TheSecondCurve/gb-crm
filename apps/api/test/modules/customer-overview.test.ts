// 客户总览（K47）：stats 计算（paid 求和、lastDealAt）、deals 列表、circles 只含 kind=circle 未结束且含该客户。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
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

async function loginAsRole(role: "admin" | "operator" | "assistant") {
  const username = `u-${role}`;
  await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  return loginAs(app, username, "password123");
}

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload });

async function createCustomerAsAdmin(cookie: string, nickname: string): Promise<number> {
  const res = await post("/api/v1/customers", cookie, { nickname });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

describe("GET /api/v1/customers/:id/overview", () => {
  it("stats/deals/circles 组装正确；404 语义", async () => {
    const cookie = await loginAsRole("admin");
    const cid = await createCustomerAsAdmin(cookie, "总览客户");

    // 成交：1 笔 paid 10000 元、1 笔 paid 无金额、1 笔 gift 5000、1 笔 closed —— 只统计 paid
    await post("/api/v1/deals", cookie, {
      customerId: cid,
      stage: "paid",
      amountCents: 10000,
      deliveryDate: clock.t - 3000,
    });
    await post("/api/v1/deals", cookie, { customerId: cid, stage: "paid", amountCents: null });
    await post("/api/v1/deals", cookie, {
      customerId: cid,
      stage: "gift",
      amountCents: 5000,
      deliveryDate: clock.t - 1000,
    });
    await post("/api/v1/deals", cookie, {
      customerId: cid,
      stage: "closed",
      amountCents: 99999,
      deliveryDate: clock.t - 5000,
    });

    // 圈子交付：类型 kind=circle；一个未结束（endsAt 未来）、一个已结束（endsAt 过去）
    const circleType = (
      await post("/api/v1/delivery-types", cookie, { name: "私董圈子", kind: "circle" })
    ).json().data;
    const activeCircle = (
      await post("/api/v1/deliveries", cookie, {
        deliveryTypeId: circleType.id,
        customerIds: [cid],
        startsAt: clock.t - 1000,
        endsAt: clock.t + 100000,
      })
    ).json().data;
    await post("/api/v1/deliveries", cookie, {
      deliveryTypeId: circleType.id,
      customerIds: [cid],
      startsAt: clock.t - 200000,
      endsAt: clock.t - 100000,
    });
    // 咨询类交付（非圈子）：不应出现在 circles
    const consultingType = (
      await post("/api/v1/delivery-types", cookie, { name: "一对一咨询", kind: "consulting" })
    ).json().data;
    await post("/api/v1/deliveries", cookie, {
      deliveryTypeId: consultingType.id,
      customerIds: [cid],
    });

    const res = await get(`/api/v1/customers/${cid}/overview`, cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;

    // customer 全量
    expect(data.customer.nickname).toBe("总览客户");

    // stats：4 笔成交；paid 合计 10000 分；lastDealAt = MAX(COALESCE(delivery_date, created_at))
    // （无 deliveryDate 的成交 created_at=clock.t，大于 gift 的 deliveryDate=clock.t-1000）
    expect(data.stats.dealCount).toBe(4);
    expect(data.stats.paidTotalCents).toBe(10000);
    expect(data.stats.lastDealAt).toBe(clock.t);

    // deals：最新在前（deliveryDate DESC）
    expect(data.deals).toHaveLength(4);
    expect(data.deals[0].deliveryDate).toBe(clock.t - 1000);

    // circles：只含未结束的圈子交付
    expect(data.circles).toHaveLength(1);
    expect(data.circles[0].id).toBe(activeCircle.id);
    expect(data.circles[0].deliveryType.kind).toBe("circle");
    expect(data.circles[0].customers).toEqual([{ id: cid, nickname: "总览客户" }]);

    // 404：不存在/软删
    expect((await get("/api/v1/customers/9999/overview", cookie)).statusCode).toBe(404);
  });

  it("assistant 可读总览（customers.read）；未登录 401", async () => {
    const adminCookie = await loginAsRole("admin");
    const cid = await createCustomerAsAdmin(adminCookie, "只读客户");

    const asstCookie = await loginAsRole("assistant");
    const res = await get(`/api/v1/customers/${cid}/overview`, asstCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.stats.dealCount).toBe(0);

    expect(
      (await app.inject({ method: "GET", url: `/api/v1/customers/${cid}/overview` })).statusCode,
    ).toBe(401);
  });
});
