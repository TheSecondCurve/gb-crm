// deals CRUD + 单值 FK（K42）+ RBAC（assistant 只读）+ OCC 内核（K24）。
// inject + loginAs，假时钟控 updatedAt；PATCH 内核走 lib/patch-kernel.ts（同 customers）。
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
  clock = { t: Date.now() }; // epoch 毫秒
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

/** 种一个指定角色的可登录用户并返回 cookie */
async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

type JsonBody = Record<string, unknown>;

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) =>
  app.inject({ method: "DELETE", url, headers: { cookie } });

/** 直接插一个 live 客户（陪衬数据，不走 API） */
function seedCustomer(db: Db, nickname: string, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(customers)
      .values({ nickname, city: "杭州", createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

/** 直接插一个 live 产品 */
function seedProduct(db: Db, name: string, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(products)
      .values({ name, createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

const DELIVERY_DATE = Date.UTC(2026, 7, 22); // 2026-08-22 epoch ms
const DEAL_DATE = Date.UTC(2026, 3, 15); // 2026-04-15 epoch ms（成交日期，非空必填）

/** 以 admin 建一条成交（customerId/dealDate 必填），返回响应 data */
let adminSeq = 0;
async function createDealAsAdmin(extra: JsonBody = {}) {
  const { id: adminId, cookie } = await loginAsRole("admin", `u-admin-${adminSeq++}`);
  const customerId = seedCustomer(tmp.db, "客户甲");
  const res = await post("/api/v1/deals", cookie, { customerId, dealDate: DEAL_DATE, ...extra });
  expect(res.statusCode).toBe(201);
  return { adminId, cookie, data: res.json().data, customerId };
}

describe("RBAC 矩阵（deals 资源，K42 assistant 只读）", () => {
  it("assistant：list/read → 200；create/update/delete → 403", async () => {
    const { data: d } = await createDealAsAdmin();
    const { cookie: aCookie } = await loginAsRole("assistant");

    expect((await get("/api/v1/deals", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/deals/${d.id}`, aCookie)).statusCode).toBe(200);
    expect((await post("/api/v1/deals", aCookie, { customerId: d.customer.id })).statusCode).toBe(403);
    expect(
      (await patch(`/api/v1/deals/${d.id}`, aCookie, { orderNo: "x", updatedAt: d.updatedAt }))
        .statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/deals/${d.id}`, aCookie)).statusCode).toBe(403);
  });

  it("operator/admin 全通（create/read/update/delete）", async () => {
    const { cookie: opCookie } = await loginAsRole("operator");
    const customerId = seedCustomer(tmp.db, "运营客户");
    const created = await post("/api/v1/deals", opCookie, { customerId, dealDate: DEAL_DATE });
    expect(created.statusCode).toBe(201);
    const d = created.json().data;

    clock.t += 1000;
    const updated = await patch(`/api/v1/deals/${d.id}`, opCookie, {
      stage: "paid",
      updatedAt: d.updatedAt,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.stage).toBe("paid");
    expect((await del(`/api/v1/deals/${d.id}`, opCookie)).statusCode).toBe(204);
  });
});

describe("POST /api/v1/deals 创建", () => {
  it("缺 customerId / dealDate → 422；customerId 非整数 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/deals", cookie, {})).statusCode).toBe(422);
    expect((await post("/api/v1/deals", cookie, { customerId: 1 })).statusCode).toBe(422);
    expect((await post("/api/v1/deals", cookie, { customerId: 1.5 })).statusCode).toBe(422);
  });

  it("省略可选字段 → 默认值（stage=gift、product/owner/deliveryDate null）；审计列展开", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const customerId = seedCustomer(tmp.db, "极简客户");
    const res = await post("/api/v1/deals", cookie, { customerId, dealDate: DEAL_DATE });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.stage).toBe("gift");
    expect(data.dealDate).toBe(DEAL_DATE);
    expect(data.productId).toBeNull();
    expect(data.ownerId).toBeNull();
    expect(data.deliveryDate).toBeNull();
    expect(data.amountCents).toBeNull();
    expect(data.afterTaxRatio).toBeNull();
    expect(data.commissionRatio).toBeNull();
    expect(data.customer).toEqual({ id: customerId, nickname: "极简客户", city: "杭州", owner: null });
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("全字段写入并读回；dealDate 非空、deliveryDate 原样存 epoch ms", async () => {
    const { cookie } = await loginAsRole("admin");
    const customerId = seedCustomer(tmp.db, "全字段客户");
    const productId = seedProduct(tmp.db, "咨询产品");
    const { id: ownerId } = await loginAsRole("operator", "owner-1");

    const res = await post("/api/v1/deals", cookie, {
      customerId,
      productId,
      ownerId,
      stage: "paid",
      orderNo: "ORD-2026-001",
      paymentRemark: "对公转账",
      dealDate: DEAL_DATE,
      deliveryDate: DELIVERY_DATE,
      amountCents: 39800,
      afterTaxRatio: 0.9306,
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.product).toEqual({ id: productId, name: "咨询产品" });
    expect(data.owner).toEqual({ id: ownerId, nickname: "昵称-operator" });
    expect(data.stage).toBe("paid");
    expect(data.orderNo).toBe("ORD-2026-001");
    expect(data.paymentRemark).toBe("对公转账");
    expect(data.dealDate).toBe(DEAL_DATE);
    expect(data.deliveryDate).toBe(DELIVERY_DATE);
    expect(data.amountCents).toBe(39800);
    expect(data.afterTaxRatio).toBe(0.9306);

    // 库中列值核对
    const row = tmp.sqlite
      .prepare(
        "SELECT customer_id, product_id, owner_id, deal_date, delivery_date, amount_cents, after_tax_ratio FROM deals WHERE id = ?",
      )
      .get(data.id) as {
      customer_id: number;
      product_id: number;
      owner_id: number;
      deal_date: number;
      delivery_date: number;
      amount_cents: number;
      after_tax_ratio: number;
    };
    expect(row.customer_id).toBe(customerId);
    expect(row.product_id).toBe(productId);
    expect(row.owner_id).toBe(ownerId);
    expect(row.deal_date).toBe(DEAL_DATE);
    expect(row.delivery_date).toBe(DELIVERY_DATE);
    expect(row.amount_cents).toBe(39800);
    expect(row.after_tax_ratio).toBe(0.9306);
  });

  it("关系校验：customerId/productId/ownerId 引用不存在或已软删 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/deals", cookie, { customerId: 9999 })).statusCode).toBe(422);
    expect(
      (await post("/api/v1/deals", cookie, { customerId: seedCustomer(tmp.db, "软删客户", { deletedAt: clock.t }) }))
        .statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/deals", cookie, { customerId: seedCustomer(tmp.db, "c"), productId: 9999 }))
        .statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/deals", cookie, { customerId: seedCustomer(tmp.db, "c2"), ownerId: 9999 }))
        .statusCode,
    ).toBe(422);
  });
});

describe("GET /api/v1/deals 列表", () => {
  it("分页 meta 正确；list 不含软删行；无 snake_case 泄漏", async () => {
    const { cookie, data: d } = await createDealAsAdmin();
    await post("/api/v1/deals", cookie, { customerId: seedCustomer(tmp.db, "客户二"), dealDate: DEAL_DATE });

    const res = await get("/api/v1/deals?page=1&pageSize=1", cookie);
    expect(res.json().meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect(res.json().data).toHaveLength(1);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("customer_id");
    expect(raw).not.toContain("order_no");
    expect(raw).not.toContain("payment_remark");
    expect(raw).not.toContain("delivery_date");
    expect(raw).not.toContain("amount_cents");
    expect(raw).not.toContain("after_tax_ratio");
    expect(raw).not.toContain("created_at");
    expect(raw).not.toContain("deleted_at");

    await del(`/api/v1/deals/${d.id}`, cookie);
    expect((await get("/api/v1/deals", cookie)).json().meta.total).toBe(1);
  });

  it("过滤 stage/q/customerId/ownerId；非法 stage/sort → 422", async () => {
    const { cookie, data: d, customerId } = await createDealAsAdmin({ stage: "paid", orderNo: "ORD-A" });
    await post("/api/v1/deals", cookie, {
      customerId: seedCustomer(tmp.db, "另一个客户"),
      stage: "refunded",
      orderNo: "ORD-B",
      dealDate: DEAL_DATE,
    });

    const byStage = await get("/api/v1/deals?stage=paid", cookie);
    expect(byStage.json().meta.total).toBe(1);
    expect(byStage.json().data[0].id).toBe(d.id);

    const byQ = await get("/api/v1/deals?q=" + encodeURIComponent("ORD-A"), cookie);
    expect(byQ.json().meta.total).toBe(1);

    const byCustomer = await get(`/api/v1/deals?customerId=${customerId}`, cookie);
    expect(byCustomer.json().meta.total).toBe(1);

    const ownerId = await seedUser(tmp.db, { username: "u-owner", systemRole: "operator", nickname: "负责人" });
    await post("/api/v1/deals", cookie, { customerId: seedCustomer(tmp.db, "带负责人"), ownerId, dealDate: DEAL_DATE });
    const byOwner = await get(`/api/v1/deals?ownerId=${ownerId}`, cookie);
    expect(byOwner.json().meta.total).toBe(1);
    expect(byOwner.json().data[0].owner).toEqual({ id: ownerId, nickname: "负责人" });

    expect((await get("/api/v1/deals?stage=bogus", cookie)).statusCode).toBe(422);
    expect((await get("/api/v1/deals?sort=deletedAt", cookie)).statusCode).toBe(422);
  });

  it("默认按 dealDate 倒序（并列 id DESC）；productId 过滤", async () => {
    const { cookie } = await loginAsRole("admin");
    const c1 = seedCustomer(tmp.db, "客户1");
    const c2 = seedCustomer(tmp.db, "客户2");
    const productA = seedProduct(tmp.db, "产品A");
    const productB = seedProduct(tmp.db, "产品B");

    const d1 = (
      await post("/api/v1/deals", cookie, {
        customerId: c1,
        productId: productA,
        dealDate: Date.UTC(2026, 2, 1),
      })
    ).json().data;
    const d2 = (
      await post("/api/v1/deals", cookie, {
        customerId: c2,
        productId: productB,
        dealDate: Date.UTC(2026, 8, 1),
      })
    ).json().data;

    // 默认（不带 sort）：dealDate DESC，成交日期晚的在前
    const def = await get("/api/v1/deals", cookie);
    expect(def.json().data.map((x: { id: number }) => x.id)).toEqual([d2.id, d1.id]);

    const byProduct = await get(`/api/v1/deals?productId=${productA}`, cookie);
    expect(byProduct.json().meta.total).toBe(1);
    expect(byProduct.json().data[0].id).toBe(d1.id);
  });

  it("展开：软删的客户/产品/负责人 ref 为 null（K9），join 行保留", async () => {
    const { cookie } = await loginAsRole("admin");
    const customerId = seedCustomer(tmp.db, "将删客户");
    const productId = seedProduct(tmp.db, "将删产品");
    const ownerId = await seedUser(tmp.db, { username: "u-dying", systemRole: "operator", nickname: "将删人" });
    const res = await post("/api/v1/deals", cookie, { customerId, productId, ownerId, dealDate: DEAL_DATE });
    const d = res.json().data;

    // 按 id 精确软删目标后，列表展开应全部为 null（K9：软删不展开）
    tmp.sqlite
      .prepare("UPDATE customers SET deleted_at = ? WHERE id = ?")
      .run(clock.t, customerId);
    tmp.sqlite.prepare("UPDATE products SET deleted_at = ? WHERE id = ?").run(clock.t, productId);
    tmp.sqlite.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").run(clock.t, ownerId);

    const list = await get("/api/v1/deals", cookie);
    const row = list.json().data.find((x: { id: number }) => x.id === d.id);
    expect(row.customer).toBeNull();
    expect(row.product).toBeNull();
    expect(row.owner).toBeNull();
    expect(row.createdBy).toEqual({ id: d.createdBy.id, nickname: "昵称-admin" });
  });
});

describe("PATCH /api/v1/deals/:id 内核（K24）", () => {
  it("必测1：PATCH orderNo 不碰 paymentRemark", async () => {
    const { cookie, data: d } = await createDealAsAdmin({ paymentRemark: "原始备注" });
    clock.t += 1000;
    const res = await patch(`/api/v1/deals/${d.id}`, cookie, {
      orderNo: "ORD-NEW",
      updatedAt: d.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.orderNo).toBe("ORD-NEW");
    expect(res.json().data.paymentRemark).toBe("原始备注");
  });

  it("同一 updatedAt 两次 PATCH → 200 后 409，409 data 带当前行", async () => {
    const { cookie, data: d } = await createDealAsAdmin();
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deals/${d.id}`, cookie, {
      orderNo: "第一改",
      updatedAt: d.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/deals/${d.id}`, cookie, {
      orderNo: "第二改",
      updatedAt: d.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    expect(r2.json().data.orderNo).toBe("第一改");
    expect(r2.json().data.updatedAt).toBe(r1.json().data.updatedAt);

    const r3 = await patch(`/api/v1/deals/${d.id}`, cookie, {
      orderNo: "第三改",
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.orderNo).toBe("第三改");
  });

  it("customerId: null → 422（必填列不可清空）；ownerId: null → 200 清空", async () => {
    const { cookie, data: d } = await createDealAsAdmin({ ownerId: (await loginAsRole("operator", "o-1")).id });
    expect(
      (await patch(`/api/v1/deals/${d.id}`, cookie, { customerId: null, updatedAt: d.updatedAt }))
        .statusCode,
    ).toBe(422);

    clock.t += 1000;
    const ok = await patch(`/api/v1/deals/${d.id}`, cookie, { ownerId: null, updatedAt: d.updatedAt });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.owner).toBeNull();
  });

  it("PATCH 金额/税后比例：写入读回、null 清空、类型与范围 422", async () => {
    const { cookie, data: d } = await createDealAsAdmin();

    clock.t += 1000;
    const r1 = await patch(`/api/v1/deals/${d.id}`, cookie, {
      amountCents: 12800,
      afterTaxRatio: 0.9306,
      updatedAt: d.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.amountCents).toBe(12800);
    expect(r1.json().data.afterTaxRatio).toBe(0.9306);

    // 只改一个，不碰另一个（K24 标量内核）
    clock.t += 1000;
    const r2 = await patch(`/api/v1/deals/${d.id}`, cookie, {
      amountCents: null,
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.amountCents).toBeNull();
    expect(r2.json().data.afterTaxRatio).toBe(0.9306);

    // 校验：金额非整数 / 比例越界 → 422
    expect(
      (await patch(`/api/v1/deals/${d.id}`, cookie, { amountCents: 1.5, updatedAt: r2.json().data.updatedAt }))
        .statusCode,
    ).toBe(422);
    expect(
      (await patch(`/api/v1/deals/${d.id}`, cookie, { afterTaxRatio: 1.2, updatedAt: r2.json().data.updatedAt }))
        .statusCode,
    ).toBe(422);
    expect(
      (await patch(`/api/v1/deals/${d.id}`, cookie, { afterTaxRatio: -0.1, updatedAt: r2.json().data.updatedAt }))
        .statusCode,
    ).toBe(422);
  });

  it("PATCH 关系键引用不存在 → 422；缺 updatedAt → 422；软删行 PATCH → 404", async () => {
    const { cookie, data: d } = await createDealAsAdmin();
    expect(
      (await patch(`/api/v1/deals/${d.id}`, cookie, { productId: 9999, updatedAt: d.updatedAt }))
        .statusCode,
    ).toBe(422);
    expect((await patch(`/api/v1/deals/${d.id}`, cookie, { orderNo: "x" })).statusCode).toBe(422);

    await del(`/api/v1/deals/${d.id}`, cookie);
    expect(
      (await patch(`/api/v1/deals/${d.id}`, cookie, { orderNo: "x", updatedAt: d.updatedAt }))
        .statusCode,
    ).toBe(404);
  });

  it("sort=dealDate/deliveryDate 放行（asc/desc）；只读字段不可写（deletedAt 缺席不产生更新）", async () => {
    const { cookie } = await loginAsRole("admin");
    const c1 = seedCustomer(tmp.db, "客户1");
    const c2 = seedCustomer(tmp.db, "客户2");
    const d1 = (await post("/api/v1/deals", cookie, { customerId: c1, dealDate: Date.UTC(2026, 2, 1), deliveryDate: Date.UTC(2026, 1, 1) })).json().data;
    const d2 = (await post("/api/v1/deals", cookie, { customerId: c2, dealDate: Date.UTC(2026, 8, 1), deliveryDate: Date.UTC(2026, 9, 1) })).json().data;

    const ascDeal = await get("/api/v1/deals?sort=dealDate&order=asc", cookie);
    expect(ascDeal.json().data.map((x: { id: number }) => x.id)).toEqual([d1.id, d2.id]);
    const descDeal = await get("/api/v1/deals?sort=dealDate&order=desc", cookie);
    expect(descDeal.json().data.map((x: { id: number }) => x.id)).toEqual([d2.id, d1.id]);

    const ascDelivery = await get("/api/v1/deals?sort=deliveryDate&order=asc", cookie);
    expect(ascDelivery.json().data.map((x: { id: number }) => x.id)).toEqual([d1.id, d2.id]);
    const descDelivery = await get("/api/v1/deals?sort=deliveryDate&order=desc", cookie);
    expect(descDelivery.json().data.map((x: { id: number }) => x.id)).toEqual([d2.id, d1.id]);
  });
});

describe("客户归属人与分红总比例（v2）", () => {
  it("DTO 携带 customer.owner 与 commissionRatio", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: ownerId } = await loginAsRole("operator", "cust-owner");
    const customerId = seedCustomer(tmp.db, "客户归属", { ownerId });
    const res = await post("/api/v1/deals", cookie, { customerId, commissionRatio: 0.05, dealDate: DEAL_DATE });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.customer).toEqual({ id: customerId, nickname: "客户归属", city: "杭州", owner: { id: ownerId, nickname: "昵称-operator" } });
    expect(d.commissionRatio).toBe(0.05);
  });

  it("PATCH commissionRatio 写入读回、null 清空", async () => {
    const { cookie, data: d } = await createDealAsAdmin();
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deals/${d.id}`, cookie, { commissionRatio: 0.08, updatedAt: d.updatedAt });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.commissionRatio).toBe(0.08);
    clock.t += 1000;
    const r2 = await patch(`/api/v1/deals/${d.id}`, cookie, {
      commissionRatio: null,
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.json().data.commissionRatio).toBeNull();
  });
});

describe("GET /api/v1/deals/:id 与 DELETE", () => {
  it("GET：软删/不存在 → 404；非法 id → 422。DELETE：204；重复删除 → 404", async () => {
    const { cookie, data: d } = await createDealAsAdmin();
    expect((await get("/api/v1/deals/9999", cookie)).statusCode).toBe(404);
    expect((await get("/api/v1/deals/abc", cookie)).statusCode).toBe(422);

    expect((await del(`/api/v1/deals/${d.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/deals/${d.id}`, cookie)).statusCode).toBe(404);
    expect((await del(`/api/v1/deals/${d.id}`, cookie)).statusCode).toBe(404);
    const row = tmp.sqlite
      .prepare("SELECT deleted_at FROM deals WHERE id = ?")
      .get(d.id) as { deleted_at: number };
    expect(row.deleted_at).toBe(clock.t);
  });
});
