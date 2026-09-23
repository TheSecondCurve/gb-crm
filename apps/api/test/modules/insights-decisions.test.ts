// K62 二期决策台：geo 选址 / ladder 阶梯 / intent 意图 / guard 守护（确定性规则）。
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

async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

type JsonBody = Record<string, unknown>;
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function createCustomer(cookie: string, nickname: string, extra: JsonBody = {}): Promise<number> {
  const res = await post("/api/v1/customers", cookie, { nickname, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

async function createPaidDeal(cookie: string, customerId: number, amountCents: number, dealDate: number): Promise<void> {
  const res = await post("/api/v1/deals", cookie, {
    customerId,
    stage: "paid",
    dealDate,
    amountCents,
  });
  expect(res.statusCode).toBe(201);
}

const DAY = 86_400_000;

describe("选址台 GET /insights/geo", () => {
  it("城市聚合 + 未开发城市结论；assistant 403", async () => {
    const admin = await loginAsRole("admin");
    // 上海：1 位暖客户（近期 lead，权重 4 → 温度 ≥25）+ 1 条活跃 need
    const sh = await createCustomer(admin.cookie, "上海暖客", { city: "上海" });
    await post(`/api/v1/customers/${sh}/records`, admin.cookie, { kind: "lead", happenedAt: clock.t - 3 * DAY, content: "咨询" });
    await post("/api/v1/insights/signals", admin.cookie, { customerId: sh, type: "need", topic: "小红书运营", content: "找代运营", sourceAt: clock.t - 5 * DAY });
    // 成都：冷客户（无触点）
    await createCustomer(admin.cookie, "成都冷客", { city: "成都" });

    const res = await get("/api/v1/insights/geo", admin.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.total).toBe(2);
    const shRow = body.data.cities.find((c: { city: string }) => c.city === "上海");
    expect(shRow.warm).toBe(1);
    expect(shRow.activeNeeds).toBe(1);
    expect(body.data.conclusion).toContain("上海");
    expect(body.data.conclusion).toContain("从未办过场次");
    expect(body.meta.calibre).toBeTruthy();

    const asst = await loginAsRole("assistant");
    expect((await get("/api/v1/insights/geo", asst.cookie)).statusCode).toBe(403);
  });
});

describe("阶梯台 GET /insights/ladder", () => {
  it("梯级分布 + 升级就绪 + 标签过期候选", async () => {
    const admin = await loginAsRole("admin");
    const prodRes = await post("/api/v1/products", admin.cookie, { name: "圈子年卡", productType: "circle_sub" });
    const prodId = prodRes.json().data.id;
    // 圈子客户 + 活跃意向 → 升级就绪（circle → 多类复购）
    const circleC = await createCustomer(admin.cookie, "圈子客户");
    await createPaidDeal(admin.cookie, circleC, 1_000_000, clock.t - 30 * DAY);
    // 把 deal 挂上圈子产品（PATCH product_id）
    const dealId = (tmp.sqlite.prepare("SELECT id FROM deals WHERE customer_id=?").get(circleC) as { id: number }).id;
    await app.inject({ method: "PATCH", url: `/api/v1/deals/${dealId}`, headers: { cookie: admin.cookie }, payload: { productId: prodId, updatedAt: (tmp.sqlite.prepare("SELECT updated_at FROM deals WHERE id=?").get(dealId) as { updated_at: number }).updated_at } });
    await post("/api/v1/insights/signals", admin.cookie, { customerId: circleC, type: "intent", topic: "私董", content: "对私董有意向", sourceAt: clock.t - 2 * DAY });
    // 有阶段标签但零成交 → 标签过期候选
    const tagRes = await post("/api/v1/tags", admin.cookie, { name: "意向客户", scope: "stage" });
    await createCustomer(admin.cookie, "只贴标签", { tagIds: [tagRes.json().data.id] });

    const res = await get("/api/v1/insights/ladder", admin.cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    const circleRung = data.rungs.find((r: { key: string }) => r.key === "circle");
    expect(circleRung.count).toBe(1);
    expect(circleRung.upgradeReadyCount).toBeGreaterThanOrEqual(1);
    expect(circleRung.upgradeReady[0].nextLabel).toBe("多类复购");
    expect(data.staleTagCount).toBe(1);
    expect(data.conclusion).toContain("升级门口");
  });
});

describe("意图台 GET /insights/intent", () => {
  it("意向清单 + topic 聚合 + 交叉销售标记", async () => {
    const admin = await loginAsRole("admin");
    const c1 = await createCustomer(admin.cookie, "金主新意向", { city: "上海" });
    await createPaidDeal(admin.cookie, c1, 2_000_000, clock.t - 10 * DAY);
    await post("/api/v1/insights/signals", admin.cookie, { customerId: c1, type: "intent", topic: "私董", content: "想了解私董", sourceAt: clock.t - 2 * DAY });
    const c2 = await createCustomer(admin.cookie, "新客意向", { city: "成都" });
    await post("/api/v1/insights/signals", admin.cookie, { customerId: c2, type: "need", topic: "私董", content: "找私董资源", sourceAt: clock.t - 3 * DAY });

    const res = await get("/api/v1/insights/intent", admin.cookie);
    const data = res.json().data;
    expect(data.total).toBe(2);
    expect(data.topics[0]).toMatchObject({ topic: "私董", count: 2, cityCount: 2 });
    const goldRow = data.rows.find((r: { nickname: string }) => r.nickname === "金主新意向");
    expect(goldRow.crossSell).toBe(true);
    expect(data.crossSellCount).toBe(1);
    expect(data.conclusion).toContain("私董");
  });
});

describe("守护台 GET /insights/guard", () => {
  it("四类信号规则全命中并排序（紧急在前）", async () => {
    const admin = await loginAsRole("admin");
    // 1) 沉睡金主：100 天前 paid 2 万（温度已衰减到冰点），无任何记录
    const whale = await createCustomer(admin.cookie, "沉睡金主");
    await createPaidDeal(admin.cookie, whale, 2_000_000, clock.t - 100 * DAY);
    // 2) 断线线索：10 天前 intent，之后无跟进
    const broken = await createCustomer(admin.cookie, "断线客户");
    await post("/api/v1/insights/signals", admin.cookie, { customerId: broken, type: "intent", topic: "下午茶", content: "咨询下午茶", sourceAt: clock.t - 10 * DAY });
    // 3) 续费窗口：圈子交付 15 天后到期
    const renew = await createCustomer(admin.cookie, "续费客户");
    const dtRes = await post("/api/v1/delivery-types", admin.cookie, { name: "闪光圈子", kind: "circle" });
    const deliveryRes = await post("/api/v1/deliveries", admin.cookie, {
      deliveryTypeId: dtRes.json().data.id,
      name: "3 期圈子",
      startsAt: clock.t - 100 * DAY,
      endsAt: clock.t + 15 * DAY,
      customerIds: [renew],
    });
    expect(deliveryRes.statusCode).toBe(201);
    // 4) 意向过期：100 天前的 intent（90 天 TTL → 10 天前过期）
    const expired = await createCustomer(admin.cookie, "过期客户");
    await post("/api/v1/insights/signals", admin.cookie, { customerId: expired, type: "intent", topic: "直播带货", content: "想学直播", sourceAt: clock.t - 100 * DAY });

    const res = await get("/api/v1/insights/guard", admin.cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    const kinds = new Set(data.items.map((i: { kind: string }) => i.kind));
    expect(kinds).toEqual(new Set(["sleeping_whale", "broken_lead", "renewal_window", "expired_intent"]));
    expect(data.highCount).toBe(2);
    expect(data.sleepingWhaleValueCents).toBe(2_000_000);
    // 紧急在前
    const urgencies = data.items.map((i: { urgency: string }) => i.urgency);
    expect(urgencies.indexOf("mid")).toBeGreaterThan(urgencies.lastIndexOf("high"));
    expect(data.conclusion).toContain("沉睡金主在册价值 ¥20,000");
  });

  it("断线判定：信号后有跟进记录则不报警", async () => {
    const admin = await loginAsRole("admin");
    const c = await createCustomer(admin.cookie, "正常跟进");
    await post("/api/v1/insights/signals", admin.cookie, { customerId: c, type: "intent", topic: "下午茶", content: "咨询", sourceAt: clock.t - 10 * DAY });
    await post(`/api/v1/customers/${c}/records`, admin.cookie, { kind: "follow_up", happenedAt: clock.t - 5 * DAY, content: "已回访" });

    const res = await get("/api/v1/insights/guard", admin.cookie);
    expect(res.json().data.items.filter((i: { kind: string }) => i.kind === "broken_lead")).toHaveLength(0);
  });
});
