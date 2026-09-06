// deal-commissions（K56）：成交分红管理——默认方案推导 / 自定义配置 / 兜底校验 / RBAC。
// inject + loginAs，假时钟控 updatedAt；默认方案走 system_configs（PATCH /system/commission-default）。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { customers, products } from "../../src/db/schema.js";
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

function seedProduct(db: Db, name: string, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(products)
      .values({ name, createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

/** 建一笔成交（API，admin），可选金额/负责人/成交日期/交付日期 */
async function createDealAsAdmin(extra: JsonBody = {}): Promise<{
  cookie: string;
  data: { id: number; customerId: number; amountCents: number | null; afterTaxRatio: number | null; updatedAt: number };
  customerId: number;
}> {
  const { cookie } = await loginAsRole("admin");
  const customerId = seedCustomer(tmp.db, "客户甲");
  const res = await post("/api/v1/deals", cookie, { customerId, dealDate: Date.UTC(2026, 5, 15), ...extra });
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

describe("DTO 展示字段", () => {
  it("列表/单条 DTO 携带成交阶段/订单号/支付信息备注", async () => {
    const { cookie } = await loginAsRole("admin");
    const { data: d } = await createDealAsAdmin({
      stage: "paid",
      orderNo: "ORD-DISPLAY",
      paymentRemark: "对公转账",
    });
    const one = await get(`/api/v1/deals/${d.id}/commissions`, cookie);
    expect(one.statusCode).toBe(200);
    expect(one.json().data.stage).toBe("paid");
    expect(one.json().data.orderNo).toBe("ORD-DISPLAY");
    expect(one.json().data.paymentRemark).toBe("对公转账");

    const list = await get(`/api/v1/deals/commissions?q=ORD-DISPLAY`, cookie);
    expect(list.statusCode).toBe(200);
    const row = list.json().data[0];
    expect(row.stage).toBe("paid");
    expect(row.orderNo).toBe("ORD-DISPLAY");
    expect(row.paymentRemark).toBe("对公转账");
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
      dealDate: clock.t,
    });
    const d = deal.json().data;

    const patchDefault = await patch("/api/v1/system/commission-default", cookie, {
      totalRatio: 0.05,
      rules: [
        { source: "owner", percentage: 0.3 },
        { source: "dealOwner", percentage: 0.4 },
        { source: "user", userId: helperId, percentage: 0.3 },
      ],
    });
    expect(patchDefault.statusCode).toBe(200);

    const res = await get(`/api/v1/deals/${d.id}/commissions`, cookie);
    expect(res.statusCode).toBe(200);
    const c = res.json().data;
    expect(c.isCustomized).toBe(false);
    expect(c.customerOwner).toEqual({ id: ownerId, nickname: "昵称-operator" });
    expect(c.owner).toEqual({ id: dealOwnerId, nickname: "昵称-operator" });
    expect(c.totalRatio).toBe(0.05);
    expect(c.totalPercentage).toBe(1);
    expect(c.baseAmountCents).toBe(90000);
    expect(c.poolAmountCents).toBe(4500);
    expect(c.items).toEqual([
      { userId: dealOwnerId, nickname: "昵称-operator", percentage: 0.4, amountCents: 1800 },
      { userId: ownerId, nickname: "昵称-operator", percentage: 0.3, amountCents: 1350 },
      { userId: helperId, nickname: "昵称-operator", percentage: 0.3, amountCents: 1350 },
    ]);
    expect(c.totalAmountCents).toBe(4500);
  });

  it("默认方案校验：user 规则缺 userId → 422；Σ>1 → 422；user 不存在 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect(
      (
        await patch("/api/v1/system/commission-default", cookie, {
          totalRatio: 0.05,
          rules: [{ source: "user", percentage: 0.1 }],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await patch("/api/v1/system/commission-default", cookie, {
          totalRatio: 0.05,
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
          totalRatio: 0.05,
          rules: [{ source: "user", userId: 9999, percentage: 0.1 }],
        })
      ).statusCode,
    ).toBe(422);
  });
});

describe("成交产品/交付日期/负责人与负责人分成（K56 扩展）", () => {
  it("DTO 携带 product/deliveryDate/owner；产品软删 → product null", async () => {
    const { cookie } = await loginAsRole("admin");
    const customerId = seedCustomer(tmp.db, "客户B");
    const productId = seedProduct(tmp.db, "咨询产品");
    const { id: ownerId } = await loginAsRole("operator", "owner-展开");
    const res = await post("/api/v1/deals", cookie, {
      customerId,
      productId,
      ownerId,
      dealDate: Date.UTC(2026, 5, 15),
      deliveryDate: Date.UTC(2026, 6, 1),
      amountCents: 100000,
      afterTaxRatio: 0.9,
    });
    const d = res.json().data;

    const c = (await get(`/api/v1/deals/${d.id}/commissions`, cookie)).json().data;
    expect(c.product).toEqual({ id: productId, name: "咨询产品" });
    expect(c.deliveryDate).toBe(Date.UTC(2026, 6, 1));
    expect(c.owner).toEqual({ id: ownerId, nickname: "昵称-operator" });
    expect(c.amountCents).toBe(100000);
    expect(c.baseAmountCents).toBe(90000);

    // 产品软删 → product null（K9）
    tmp.sqlite.prepare("UPDATE products SET deleted_at = ? WHERE id = ?").run(clock.t, productId);
    const c2 = (await get(`/api/v1/deals/${d.id}/commissions`, cookie)).json().data;
    expect(c2.product).toBeNull();
  });

  it("负责人参与分成：默认方案 dealOwner 规则 → 负责人分成比例/金额正确", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: dealOwnerId } = await loginAsRole("operator", "owner-分成");
    const customerId = seedCustomer(tmp.db, "客户C");
    const d = (
      await post("/api/v1/deals", cookie, {
        customerId,
        ownerId: dealOwnerId,
        amountCents: 100000,
        afterTaxRatio: 0.9,
        dealDate: clock.t,
      })
    ).json().data;

    await patch("/api/v1/system/commission-default", cookie, {
      totalRatio: 0.1,
      rules: [{ source: "dealOwner", percentage: 1 }],
    });

    const c = (await get(`/api/v1/deals/${d.id}/commissions`, cookie)).json().data;
    const ownerItem = c.items.find((it: { userId: number }) => it.userId === dealOwnerId);
    expect(ownerItem.percentage).toBe(1);
    expect(ownerItem.amountCents).toBe(9000);
    expect(c.totalPercentage).toBe(1);
    expect(c.poolAmountCents).toBe(9000);
    expect(c.totalAmountCents).toBe(9000);
  });
});

describe("自定义配置 PUT /deals/:id/commissions", () => {
  it("配置后 isCustomized=true；items 覆盖默认方案；GET list 状态可筛", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: m1 } = await loginAsRole("operator", "m1");
    const { id: m2 } = await loginAsRole("operator", "m2");
    const { data: d } = await createDealAsAdmin({ amountCents: 100000, afterTaxRatio: 0.9 });

    // v2：总比例在 deals 上维护（0.1 → 分红池 = 90000 × 0.1 = 9000）
    const setRatio = await patch(`/api/v1/deals/${d.id}`, cookie, {
      commissionRatio: 0.1,
      updatedAt: d.updatedAt,
    });
    expect(setRatio.statusCode).toBe(200);

    const res = await put(`/api/v1/deals/${d.id}/commissions`, cookie, {
      items: [
        { userId: m1, percentage: 0.06 },
        { userId: m2, percentage: 0.04 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const c = res.json().data;
    expect(c.isCustomized).toBe(true);
    expect(c.totalRatio).toBe(0.1);
    expect(c.poolAmountCents).toBe(9000);
    expect(c.totalPercentage).toBe(0.1);
    expect(c.items.map((i: { userId: number }) => i.userId)).toEqual([m1, m2]);
    expect(c.items[0].amountCents).toBe(540);
    expect(c.items[1].amountCents).toBe(360);
    expect(c.totalAmountCents).toBe(900);

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
  it("按成交日期（dealDate）范围筛选", async () => {
    const { cookie } = await loginAsRole("admin");
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2026, 0, 31);
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 15) });
    await createDealAsAdmin(); // 默认 dealDate=2026-05-15，不在范围内
    await createDealAsAdmin({ orderNo: "ORD-SEARCH" }); // 默认 dealDate=2026-05-15，不在范围内

    const inRange = await get(`/api/v1/deals/commissions?startDate=${start}&endDate=${end}`, cookie);
    expect(inRange.json().meta.total).toBe(1);

    const all = await get("/api/v1/deals/commissions", cookie);
    expect(all.json().meta.total).toBe(3);

    const byQ = await get("/api/v1/deals/commissions?q=" + encodeURIComponent("ORD-SEARCH"), cookie);
    expect(byQ.json().meta.total).toBe(1);
  });
});

describe("列表：交付日期筛选（与成交日期范围独立）", () => {
  it("deliveryStatus=notEmpty 只返回已填交付日期的成交；empty 只返回未填", async () => {
    const { cookie } = await loginAsRole("admin");
    await createDealAsAdmin({ deliveryDate: Date.UTC(2026, 6, 1) });
    await createDealAsAdmin(); // 无交付日期
    await createDealAsAdmin(); // 无交付日期

    const notEmpty = await get("/api/v1/deals/commissions?deliveryStatus=notEmpty", cookie);
    expect(notEmpty.json().meta.total).toBe(1);

    const empty = await get("/api/v1/deals/commissions?deliveryStatus=empty", cookie);
    expect(empty.json().meta.total).toBe(2);
  });

  it("按交付日期范围筛选，且与成交日期范围叠加独立生效", async () => {
    const { cookie } = await loginAsRole("admin");
    const start = Date.UTC(2026, 6, 1);
    const end = Date.UTC(2026, 6, 30);
    // A：成交 05-01、交付 06-15；B：成交 05-01、交付 07-15；C：成交默认 05-15、交付 06-15
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 5, 1), deliveryDate: Date.UTC(2026, 6, 15) });
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 5, 1), deliveryDate: Date.UTC(2026, 7, 15) });
    await createDealAsAdmin({ deliveryDate: Date.UTC(2026, 6, 15) });

    const inRange = await get(
      `/api/v1/deals/commissions?deliveryStartDate=${start}&deliveryEndDate=${end}`,
      cookie,
    );
    expect(inRange.json().meta.total).toBe(2);

    // 成交日期范围（只圈 05-01~05-31）+ 交付日期范围（06-01~06-30）同时命中 A、C
    const both = await get(
      `/api/v1/deals/commissions?startDate=${Date.UTC(2026, 5, 1)}&endDate=${Date.UTC(2026, 5, 31)}&deliveryStartDate=${start}&deliveryEndDate=${end}`,
      cookie,
    );
    expect(both.json().meta.total).toBe(2);

    // 交付日期范围 + notEmpty 叠加
    const ranged = await get(
      `/api/v1/deals/commissions?deliveryStatus=notEmpty&deliveryStartDate=${start}&deliveryEndDate=${end}`,
      cookie,
    );
    expect(ranged.json().meta.total).toBe(2);
  });
});

describe("列表：阶段与金额下限筛选", () => {
  it("stage / minAmountCents 各自生效，叠加只命中已付款且金额>0", async () => {
    const { cookie } = await loginAsRole("admin");
    await createDealAsAdmin({ stage: "paid", amountCents: 10000 }); // 命中
    await createDealAsAdmin({ stage: "paid", amountCents: 0 }); // 金额不符
    await createDealAsAdmin({ stage: "refunded", amountCents: 5000 }); // 阶段不符
    await createDealAsAdmin(); // gift 默认、金额 NULL

    const both = await get("/api/v1/deals/commissions?stage=paid&minAmountCents=1", cookie);
    expect(both.json().meta.total).toBe(1);

    const paidOnly = await get("/api/v1/deals/commissions?stage=paid", cookie);
    expect(paidOnly.json().meta.total).toBe(2);

    const positiveOnly = await get("/api/v1/deals/commissions?minAmountCents=1", cookie);
    expect(positiveOnly.json().meta.total).toBe(2);

    // 与动态条件组 AND 叠加
    const withFilters = await get(
      `/api/v1/deals/commissions?stage=paid&minAmountCents=1&filters=${encodeURIComponent(
        JSON.stringify({
          combinator: "and",
          rules: [{ field: "dealDate", op: "between", from: Date.UTC(2026, 0, 1) }],
        }),
      )}`,
      cookie,
    );
    expect(withFilters.json().meta.total).toBe(1);
  });
});

describe("列表：排序（sort/order）", () => {
  it("sort=dealDate 倒序/正序；sort=amountCents 倒序 NULL 排尾；缺省按 updatedAt 倒序", async () => {
    const { cookie } = await loginAsRole("admin");
    const a = await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 1), amountCents: 100 });
    const b = await createDealAsAdmin({ dealDate: Date.UTC(2026, 2, 1), amountCents: null });
    const c = await createDealAsAdmin({ dealDate: Date.UTC(2026, 1, 1), amountCents: 300 });
    const ids = (res: { json: () => { data: { dealId: number }[] } }) =>
      res.json().data.map((r) => r.dealId);

    const descRes = await get("/api/v1/deals/commissions?sort=dealDate&order=desc", cookie);
    expect(ids(descRes)).toEqual([b.data.id, c.data.id, a.data.id]);

    const ascRes = await get("/api/v1/deals/commissions?sort=dealDate&order=asc", cookie);
    expect(ids(ascRes)).toEqual([a.data.id, c.data.id, b.data.id]);

    // 金额倒序：NULL（未填）在 SQLite 中最小 → 排尾
    const amt = await get("/api/v1/deals/commissions?sort=amountCents&order=desc", cookie);
    expect(ids(amt)).toEqual([c.data.id, a.data.id, b.data.id]);

    // 缺省保持旧行为：updatedAt 倒序（同刻按 id 倒序 → 后建在前）
    const dflt = await get("/api/v1/deals/commissions", cookie);
    expect(ids(dflt)).toEqual([c.data.id, b.data.id, a.data.id]);
  });
});

describe("列表：动态筛选条件组（filters，AND/OR）", () => {
  const fp = (g: unknown) => `filters=${encodeURIComponent(JSON.stringify(g))}`;

  it("AND：成交日期范围 + 产品 in 只命中交集", async () => {
    const { cookie } = await loginAsRole("admin");
    const p1 = seedProduct(tmp.db, "产品一");
    const p2 = seedProduct(tmp.db, "产品二");
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 15), productId: p1 }); // 命中
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 16), productId: p2 }); // 产品不符
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 2, 15), productId: p1 }); // 日期不符

    const res = await get(
      `/api/v1/deals/commissions?${fp({
        combinator: "and",
        rules: [
          { field: "dealDate", op: "between", from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 31) },
          { field: "productId", op: "in", ids: [p1] },
        ],
      })}`,
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.total).toBe(1);
  });

  it("OR：两段成交日期范围命中并集", async () => {
    const { cookie } = await loginAsRole("admin");
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 15) }); // 段一
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 5, 15) }); // 段二
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 2, 15) }); // 都不在

    const res = await get(
      `/api/v1/deals/commissions?${fp({
        combinator: "or",
        rules: [
          { field: "dealDate", op: "between", from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 31) },
          { field: "dealDate", op: "between", from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 30) },
        ],
      })}`,
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.total).toBe(2);
  });

  it("交付日期 empty/notEmpty 规则", async () => {
    const { cookie } = await loginAsRole("admin");
    await createDealAsAdmin({ deliveryDate: Date.UTC(2026, 6, 1) });
    await createDealAsAdmin();
    await createDealAsAdmin();

    const notEmpty = await get(
      `/api/v1/deals/commissions?${fp({
        combinator: "and",
        rules: [{ field: "deliveryDate", op: "notEmpty" }],
      })}`,
      cookie,
    );
    expect(notEmpty.json().meta.total).toBe(1);

    const empty = await get(
      `/api/v1/deals/commissions?${fp({
        combinator: "and",
        rules: [{ field: "deliveryDate", op: "empty" }],
      })}`,
      cookie,
    );
    expect(empty.json().meta.total).toBe(2);
  });

  it("产品 in 多 id 命中任一；单边日期只生成一边", async () => {
    const { cookie } = await loginAsRole("admin");
    const p1 = seedProduct(tmp.db, "产品一");
    const p2 = seedProduct(tmp.db, "产品二");
    const p3 = seedProduct(tmp.db, "产品三");
    await createDealAsAdmin({ productId: p1, dealDate: Date.UTC(2026, 5, 10) });
    await createDealAsAdmin({ productId: p2, dealDate: Date.UTC(2026, 5, 11) });
    await createDealAsAdmin({ productId: p3, dealDate: Date.UTC(2026, 5, 12) });

    const multi = await get(
      `/api/v1/deals/commissions?${fp({
        combinator: "and",
        rules: [{ field: "productId", op: "in", ids: [p1, p2] }],
      })}`,
      cookie,
    );
    expect(multi.json().meta.total).toBe(2);

    const afterOnly = await get(
      `/api/v1/deals/commissions?${fp({
        combinator: "and",
        rules: [{ field: "dealDate", op: "between", from: Date.UTC(2026, 5, 11) }],
      })}`,
      cookie,
    );
    expect(afterOnly.json().meta.total).toBe(2);
  });

  it("非法 filters → 422 VALIDATION", async () => {
    const { cookie } = await loginAsRole("admin");
    for (const bad of [
      "not-json",
      JSON.stringify({ combinator: "and", rules: [{ field: "nope", op: "between" }] }),
      JSON.stringify({ combinator: "xor", rules: [{ field: "productId", op: "in", ids: [1] }] }),
      JSON.stringify({ combinator: "and", rules: [] }),
      JSON.stringify({ combinator: "and", rules: [{ field: "productId", op: "in", ids: [] }] }),
    ]) {
      const res = await get(`/api/v1/deals/commissions?filters=${encodeURIComponent(bad)}`, cookie);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION");
    }
  });

  it("filters 与旧 flat 参数 AND 叠加", async () => {
    const { cookie } = await loginAsRole("admin");
    // A：成交 01-15、有交付日期；B：成交 01-16、无交付日期；C：成交 05-15、有交付日期
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 15), deliveryDate: Date.UTC(2026, 6, 1) });
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 0, 16) });
    await createDealAsAdmin({ dealDate: Date.UTC(2026, 5, 15), deliveryDate: Date.UTC(2026, 6, 1) });

    const res = await get(
      `/api/v1/deals/commissions?startDate=${Date.UTC(2026, 0, 1)}&endDate=${Date.UTC(2026, 0, 31)}&${fp({
        combinator: "and",
        rules: [{ field: "deliveryDate", op: "notEmpty" }],
      })}`,
      cookie,
    );
    expect(res.json().meta.total).toBe(1);
  });
});

describe("成交分成 v2：总比例三级回退 + 默认必含双人 + payout", () => {
  it("总比例三级回退：成交覆盖 → 产品默认 → 全局默认", async () => {
    const { cookie } = await loginAsRole("admin");
    const productId = seedProduct(tmp.db, "产品X", { commissionRatio: 0.08 });
    const customerId = seedCustomer(tmp.db, "客户T");
    await patch("/api/v1/system/commission-default", cookie, { totalRatio: 0.05, rules: [] });

    // 无成交/产品覆盖 → 全局默认 0.05
    const d1 = (await post("/api/v1/deals", cookie, { customerId, dealDate: clock.t })).json().data;
    let c = (await get(`/api/v1/deals/${d1.id}/commissions`, cookie)).json().data;
    expect(c.totalRatio).toBe(0.05);
    expect(c.productCommissionRatio).toBeNull();
    expect(c.dealCommissionRatio).toBeNull();

    // 产品默认 0.08（成交未覆盖）
    const d2 = (await post("/api/v1/deals", cookie, { customerId, productId, dealDate: clock.t })).json().data;
    c = (await get(`/api/v1/deals/${d2.id}/commissions`, cookie)).json().data;
    expect(c.totalRatio).toBe(0.08);
    expect(c.productCommissionRatio).toBe(0.08);

    // 成交覆盖 0.1
    const d3 = (
      await post("/api/v1/deals", cookie, { customerId, productId, commissionRatio: 0.1, dealDate: clock.t })
    ).json().data;
    c = (await get(`/api/v1/deals/${d3.id}/commissions`, cookie)).json().data;
    expect(c.totalRatio).toBe(0.1);
    expect(c.dealCommissionRatio).toBe(0.1);
  });

  it("默认方案总是包含成交负责人与客户归属人（规则缺席也以 0 占位）", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: dealOwnerId } = await loginAsRole("operator", "owner-必含");
    const { id: custOwnerId } = await loginAsRole("operator", "cust-owner-必含");
    const customerId = seedCustomer(tmp.db, "客户必含", { ownerId: custOwnerId });
    await patch("/api/v1/system/commission-default", cookie, { totalRatio: 0.1, rules: [] });

    const d = (
      await post("/api/v1/deals", cookie, {
        customerId,
        ownerId: dealOwnerId,
        amountCents: 100000,
        afterTaxRatio: 0.9,
        dealDate: clock.t,
      })
    ).json().data;
    const c = (await get(`/api/v1/deals/${d.id}/commissions`, cookie)).json().data;
    const uids = c.items.map((it: { userId: number }) => it.userId);
    expect(uids).toContain(dealOwnerId); // 成交负责人总在
    expect(uids).toContain(custOwnerId); // 客户归属人总在
    const ownerItem = c.items.find((it: { userId: number }) => it.userId === dealOwnerId);
    expect(ownerItem.percentage).toBe(0);
    expect(ownerItem.amountCents).toBe(0);
  });

  it("payout PUT：金额=round(分红池×rate)、交付日期为空 → 422、[] 清空", async () => {
    const { cookie } = await loginAsRole("admin");
    const { data: d } = await createDealAsAdmin({
      amountCents: 100000,
      afterTaxRatio: 0.9,
      deliveryDate: Date.UTC(2026, 6, 1),
    });
    await patch(`/api/v1/deals/${d.id}`, cookie, { commissionRatio: 0.1, updatedAt: d.updatedAt });

    const putRes = await put(`/api/v1/deals/${d.id}/payouts`, cookie, {
      payouts: [
        { seq: 1, payoutDate: Date.UTC(2026, 6, 1), rate: 0.5 },
        { seq: 2, payoutDate: Date.UTC(2026, 9, 1), rate: 0.5 },
      ],
    });
    expect(putRes.statusCode).toBe(200);
    const payouts = putRes.json().data;
    expect(payouts).toHaveLength(2);
    expect(payouts[0]).toMatchObject({ seq: 1, rate: 0.5, amountCents: 4500, status: "pending" });
    expect(payouts[1]).toMatchObject({ seq: 2, rate: 0.5, amountCents: 4500, status: "pending" });

    // 交付日期为空 → 422
    const d2 = (
      await post("/api/v1/deals", cookie, { customerId: seedCustomer(tmp.db, "无交付"), dealDate: clock.t })
    ).json().data;
    expect(
      (await put(`/api/v1/deals/${d2.id}/payouts`, cookie, { payouts: [{ seq: 1, payoutDate: clock.t, rate: 1 }] }))
        .statusCode,
    ).toBe(422);

    // [] 清空
    const clear = await put(`/api/v1/deals/${d.id}/payouts`, cookie, { payouts: [] });
    expect(clear.json().data).toEqual([]);
  });

  it("payout PATCH 状态：pending↔paid，paid 记 paid_at", async () => {
    const { cookie } = await loginAsRole("admin");
    const { data: d } = await createDealAsAdmin({
      amountCents: 100000,
      afterTaxRatio: 0.9,
      deliveryDate: Date.UTC(2026, 6, 1),
    });
    await patch(`/api/v1/deals/${d.id}`, cookie, { commissionRatio: 0.1, updatedAt: d.updatedAt });
    await put(`/api/v1/deals/${d.id}/payouts`, cookie, {
      payouts: [{ seq: 1, payoutDate: Date.UTC(2026, 6, 1), rate: 1 }],
    });

    const paid = await patch(`/api/v1/deals/${d.id}/payouts/1`, cookie, { status: "paid" });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().data.status).toBe("paid");
    expect(paid.json().data.paidAt).toBe(clock.t);

    const pending = await patch(`/api/v1/deals/${d.id}/payouts/1`, cookie, { status: "pending" });
    expect(pending.json().data.status).toBe("pending");
    expect(pending.json().data.paidAt).toBeNull();
  });

  it("列表 payoutStatus 过滤", async () => {
    const { cookie } = await loginAsRole("admin");
    const { data: d } = await createDealAsAdmin({
      amountCents: 100000,
      afterTaxRatio: 0.9,
      deliveryDate: Date.UTC(2026, 6, 1),
    });
    await patch(`/api/v1/deals/${d.id}`, cookie, { commissionRatio: 0.1, updatedAt: d.updatedAt });
    await put(`/api/v1/deals/${d.id}/payouts`, cookie, {
      payouts: [{ seq: 1, payoutDate: Date.UTC(2026, 6, 1), rate: 1 }],
    });

    const pending = await get("/api/v1/deals/commissions?payoutStatus=pending", cookie);
    expect(pending.json().meta.total).toBe(1);
    const paid = await get("/api/v1/deals/commissions?payoutStatus=paid", cookie);
    expect(paid.json().meta.total).toBe(0);
  });

  it("payout 刷新：POST /deals/:id/payouts/refresh 按当前分红池只重算待发期", async () => {
    const { cookie } = await loginAsRole("admin");
    const { data: d } = await createDealAsAdmin({
      amountCents: 100000,
      afterTaxRatio: 0.9,
      deliveryDate: Date.UTC(2026, 6, 1),
    });
    const patched = await patch(`/api/v1/deals/${d.id}`, cookie, {
      commissionRatio: 0.1,
      updatedAt: d.updatedAt,
    });
    expect(patched.statusCode).toBe(200);
    await put(`/api/v1/deals/${d.id}/payouts`, cookie, {
      payouts: [
        { seq: 1, payoutDate: Date.UTC(2026, 6, 1), rate: 0.5 },
        { seq: 2, payoutDate: Date.UTC(2026, 9, 1), rate: 0.5 },
      ],
    });
    await patch(`/api/v1/deals/${d.id}/payouts/1`, cookie, { status: "paid" });

    // 修改成交金额 → 分红池变 18000；payout 金额是物化的，不刷新不变
    const after = await patch(`/api/v1/deals/${d.id}`, cookie, {
      amountCents: 200000,
      updatedAt: patched.json().data.updatedAt,
    });
    expect(after.statusCode).toBe(200);

    const res = await post(`/api/v1/deals/${d.id}/payouts/refresh`, cookie);
    expect(res.statusCode).toBe(200);
    const payouts = res.json().data;
    // paid 期保留历史金额；pending 期重算为 round(18000 × 0.5) = 9000
    expect(payouts[0]).toMatchObject({ seq: 1, amountCents: 4500, status: "paid" });
    expect(payouts[1]).toMatchObject({ seq: 2, amountCents: 9000, status: "pending" });

    // assistant 无 dealCommissions.update → 403
    const { cookie: asst } = await loginAsRole("assistant");
    expect((await post(`/api/v1/deals/${d.id}/payouts/refresh`, asst)).statusCode).toBe(403);

    // 无 payout 的成交 → 200 空数组；不存在的成交 → 404
    const { cookie: c2, data: d2 } = await createDealAsAdmin({ deliveryDate: Date.UTC(2026, 6, 1) });
    const empty = await post(`/api/v1/deals/${d2.id}/payouts/refresh`, c2);
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data).toEqual([]);
    expect((await post("/api/v1/deals/99999/payouts/refresh", cookie)).statusCode).toBe(404);
  });
});
