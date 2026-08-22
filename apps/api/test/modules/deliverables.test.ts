// deliverables CRUD + 动作打勾清单（K43）+ 产品默认动作模板预填 + RBAC（assistant 只读）。
// inject + loginAs，假时钟控 updatedAt；交付项 PATCH 走 lib/patch-kernel.ts。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { customers, deals, products } from "../../src/db/schema.js";
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

function seedDeal(db: Db, customerId: number, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(deals)
      .values({ customerId, orderNo: "ORD-D", createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

const tasksOf = (deliverableId: number): { content: string; done: number; done_at: number | null }[] =>
  tmp.sqlite
    .prepare(
      "SELECT content, done, done_at FROM delivery_tasks WHERE deliverable_id = ? ORDER BY id",
    )
    .all(deliverableId) as { content: string; done: number; done_at: number | null }[];

/** 以 admin 建交付项（默认：live 客户+成交+圈子产品带模板），返回响应 data */
let adminSeq = 0;
async function createDeliverableAsAdmin(extra: JsonBody = {}, productExtra: JsonBody = {}) {
  const { id: adminId, cookie } = await loginAsRole("admin", `u-admin-${adminSeq++}`);
  const customerId = seedCustomer(tmp.db, "交付客户");
  const dealId = seedDeal(tmp.db, customerId);
  const productId = seedProduct(tmp.db, "圈子产品", { defaultTasks: "拉群\n商品发货", ...productExtra });
  const res = await post("/api/v1/deliverables", cookie, { dealId, productId, ...extra });
  expect(res.statusCode).toBe(201);
  return { adminId, cookie, data: res.json().data, dealId, productId, customerId };
}

describe("RBAC 矩阵（deliverables 资源，K43 assistant 只读）", () => {
  it("assistant：list/read → 200；POST/PATCH/DELETE 及任务端点 → 403", async () => {
    const { data: d } = await createDeliverableAsAdmin();
    const { cookie: aCookie } = await loginAsRole("assistant");

    expect((await get("/api/v1/deliverables", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/deliverables/${d.id}`, aCookie)).statusCode).toBe(200);
    expect((await post("/api/v1/deliverables", aCookie, { dealId: d.dealId })).statusCode).toBe(403);
    expect(
      (await patch(`/api/v1/deliverables/${d.id}`, aCookie, { status: "delivering", updatedAt: d.updatedAt }))
        .statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/deliverables/${d.id}`, aCookie)).statusCode).toBe(403);
    expect((await post(`/api/v1/deliverables/${d.id}/tasks`, aCookie, { content: "x" })).statusCode).toBe(403);
    expect(
      (await patch(`/api/v1/deliverables/${d.id}/tasks/${d.tasks[0].id}`, aCookie, {
        done: true,
        updatedAt: d.tasks[0].updatedAt,
      })).statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/deliverables/${d.id}/tasks/${d.tasks[0].id}`, aCookie)).statusCode).toBe(403);
  });

  it("operator/admin 全通（create/read/update/delete + 任务打勾）", async () => {
    const { cookie: opCookie } = await loginAsRole("operator");
    const customerId = seedCustomer(tmp.db, "运营客户");
    const dealId = seedDeal(tmp.db, customerId);
    const created = await post("/api/v1/deliverables", opCookie, { dealId });
    expect(created.statusCode).toBe(201);
    const d = created.json().data;

    clock.t += 1000;
    const updated = await patch(`/api/v1/deliverables/${d.id}`, opCookie, {
      status: "delivered",
      updatedAt: d.updatedAt,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.status).toBe("delivered");
    expect((await del(`/api/v1/deliverables/${d.id}`, opCookie)).statusCode).toBe(204);
  });
});

describe("POST /api/v1/deliverables 创建", () => {
  it("缺 dealId → 422；deal/product 不存在或已软删 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/deliverables", cookie, {})).statusCode).toBe(422);
    expect((await post("/api/v1/deliverables", cookie, { dealId: 9999 })).statusCode).toBe(422);

    const deadCustomer = seedCustomer(tmp.db, "软删客户", { deletedAt: clock.t });
    const deadDeal = seedDeal(tmp.db, deadCustomer);
    // 成交引用已软删客户 → 该 deal 不可作为交付项来源
    expect((await post("/api/v1/deliverables", cookie, { dealId: deadDeal })).statusCode).toBe(422);

    const dealId = seedDeal(tmp.db, seedCustomer(tmp.db, "正常客户"));
    expect((await post("/api/v1/deliverables", cookie, { dealId, productId: 9999 })).statusCode).toBe(422);
    const deadProduct = seedProduct(tmp.db, "软删产品", { deletedAt: clock.t });
    expect((await post("/api/v1/deliverables", cookie, { dealId, productId: deadProduct })).statusCode).toBe(422);
  });

  it("省略可选字段 → 默认值（status=pending、日期/说明/链接 null）；未配产品模板 → 任务空", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const dealId = seedDeal(tmp.db, seedCustomer(tmp.db, "极简客户"));
    const res = await post("/api/v1/deliverables", cookie, { dealId });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.status).toBe("pending");
    expect(data.planDeliverDate).toBeNull();
    expect(data.actualDeliverDate).toBeNull();
    expect(data.expiryDate).toBeNull();
    expect(data.tasks).toEqual([]);
    expect(data.deal).toEqual({ id: dealId, orderNo: "ORD-D", customer: { id: data.deal.customer.id, nickname: "极简客户" } });
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("产品配 defaultTasks → 自动预填动作清单（按行顺序）", async () => {
    const { data: d } = await createDeliverableAsAdmin();
    expect(d.tasks.map((t: { content: string }) => t.content)).toEqual(["拉群", "商品发货"]);
    expect(d.tasks.every((t: { done: boolean }) => t.done === false)).toBe(true);
    // 库里核对
    expect(tasksOf(d.id).map((r) => r.content)).toEqual(["拉群", "商品发货"]);
  });

  it("defaultTasks 空行/前后空白被清理；全部空白行 → 空清单", async () => {
    const { cookie } = await loginAsRole("admin");
    const dealId = seedDeal(tmp.db, seedCustomer(tmp.db, "c"));
    const p1 = seedProduct(tmp.db, "p1", { defaultTasks: " 拉群 \n\n  \n发货\n" });
    const r1 = await post("/api/v1/deliverables", cookie, { dealId, productId: p1 });
    expect(r1.json().data.tasks.map((t: { content: string }) => t.content)).toEqual(["拉群", "发货"]);

    const p2 = seedProduct(tmp.db, "p2", { defaultTasks: "  \n\n" });
    const r2 = await post("/api/v1/deliverables", cookie, { dealId, productId: p2 });
    expect(r2.json().data.tasks).toEqual([]);
  });
});

describe("GET /api/v1/deliverables 列表", () => {
  it("分页 meta；软删不出现；无 snake_case 泄漏", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin();
    await post("/api/v1/deliverables", cookie, { dealId: seedDeal(tmp.db, seedCustomer(tmp.db, "客户二")) });

    const res = await get("/api/v1/deliverables?page=1&pageSize=1", cookie);
    expect(res.json().meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("deal_id");
    expect(raw).not.toContain("product_id");
    expect(raw).not.toContain("plan_deliver_date");
    expect(raw).not.toContain("delivery_url");
    expect(raw).not.toContain("deleted_at");

    await del(`/api/v1/deliverables/${d.id}`, cookie);
    expect((await get("/api/v1/deliverables", cookie)).json().meta.total).toBe(1);
  });

  it("过滤 status/dealId/productId/customerId；q 搜客户昵称", async () => {
    const { cookie, data: d, dealId, productId, customerId } = await createDeliverableAsAdmin({ status: "delivering" });
    await post("/api/v1/deliverables", cookie, {
      dealId: seedDeal(tmp.db, seedCustomer(tmp.db, "另一个客户")),
      status: "delivered",
    });

    const byStatus = await get("/api/v1/deliverables?status=delivering", cookie);
    expect(byStatus.json().meta.total).toBe(1);
    expect(byStatus.json().data[0].id).toBe(d.id);

    expect((await get(`/api/v1/deliverables?dealId=${dealId}`, cookie)).json().meta.total).toBe(1);
    expect((await get(`/api/v1/deliverables?productId=${productId}`, cookie)).json().meta.total).toBe(1);
    expect((await get(`/api/v1/deliverables?customerId=${customerId}`, cookie)).json().meta.total).toBe(1);

    const byQ = await get("/api/v1/deliverables?q=" + encodeURIComponent("交付客户"), cookie);
    expect(byQ.json().meta.total).toBe(1);
    expect(byQ.json().data[0].id).toBe(d.id);
    const none = await get("/api/v1/deliverables?q=" + encodeURIComponent("不存在的人"), cookie);
    expect(none.json().meta.total).toBe(0);

    expect((await get("/api/v1/deliverables?status=bogus", cookie)).statusCode).toBe(422);
    expect((await get("/api/v1/deliverables?sort=deletedAt", cookie)).statusCode).toBe(422);
  });

  it("展开：deal（含 customer nickname）/product/tasks；软删 deal 后 ref 为 null（K9）", async () => {
    const { cookie, data: d, dealId, productId } = await createDeliverableAsAdmin();
    const row = (await get("/api/v1/deliverables", cookie)).json().data.find(
      (x: { id: number }) => x.id === d.id,
    );
    expect(row.deal.id).toBe(dealId);
    expect(row.deal.customer.nickname).toBe("交付客户");
    expect(row.product).toEqual({ id: productId, name: "圈子产品" });
    expect(row.tasks).toHaveLength(2);

    // 软删成交后 deal ref 不展开（任务/交付项行保留）
    tmp.sqlite.prepare("UPDATE deals SET deleted_at = ? WHERE id = ?").run(clock.t, dealId);
    const after = (await get(`/api/v1/deliverables/${d.id}`, cookie)).json().data;
    expect(after.deal).toBeNull();
    expect(after.tasks).toHaveLength(2);
  });
});

describe("PATCH /api/v1/deliverables/:id 内核（K24）", () => {
  it("status 流转 + 只改一列不碰其它；deliveryUrl null 清空", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin({ deliveryUrl: "https://a.b/c", description: "说明" });
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deliverables/${d.id}`, cookie, {
      status: "delivering",
      updatedAt: d.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.status).toBe("delivering");
    expect(r1.json().data.description).toBe("说明");
    expect(r1.json().data.deliveryUrl).toBe("https://a.b/c");
    expect(r1.json().data.tasks).toHaveLength(2); // 任务不受标量 PATCH 影响

    clock.t += 1000;
    const r2 = await patch(`/api/v1/deliverables/${d.id}`, cookie, {
      deliveryUrl: null,
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.deliveryUrl).toBeNull();
  });

  it("同一 updatedAt 两次 PATCH → 409 带当前行；软删行 PATCH → 404", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin();
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deliverables/${d.id}`, cookie, {
      status: "delivering",
      updatedAt: d.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await patch(`/api/v1/deliverables/${d.id}`, cookie, {
      status: "delivered",
      updatedAt: d.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().data.status).toBe("delivering");

    await del(`/api/v1/deliverables/${d.id}`, cookie);
    expect(
      (await patch(`/api/v1/deliverables/${d.id}`, cookie, { status: "delivered", updatedAt: r1.json().data.updatedAt }))
        .statusCode,
    ).toBe(404);
  });

  it("PATCH 关系键引用不存在 → 422；缺 updatedAt → 422", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin();
    expect(
      (await patch(`/api/v1/deliverables/${d.id}`, cookie, { productId: 9999, updatedAt: d.updatedAt }))
        .statusCode,
    ).toBe(422);
    expect((await patch(`/api/v1/deliverables/${d.id}`, cookie, { status: "x" })).statusCode).toBe(422);
  });
});

describe("任务子端点（动作打勾清单）", () => {
  it("POST 追加任务；内容空 → 422", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin();
    const res = await post(`/api/v1/deliverables/${d.id}/tasks`, cookie, { content: "开课提醒" });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.content).toBe("开课提醒");
    expect(res.json().data.done).toBe(false);
    expect((await post(`/api/v1/deliverables/${d.id}/tasks`, cookie, { content: "  " })).statusCode).toBe(422);
  });

  it("PATCH done:true 记 doneAt/doneBy（当前操作人）；done:false 清空；改 content 不动完成信息", async () => {
    const { adminId, cookie, data: d } = await createDeliverableAsAdmin();
    const task = d.tasks[0];
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie, {
      done: true,
      updatedAt: task.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.done).toBe(true);
    expect(r1.json().data.doneAt).toBe(clock.t);
    expect(r1.json().data.doneBy).toEqual({ id: adminId, nickname: "昵称-admin" });

    // 改文本不动 done 时间戳
    clock.t += 1000;
    const r2 = await patch(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie, {
      content: "拉群（含小助手）",
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.json().data.content).toBe("拉群（含小助手）");
    expect(r2.json().data.done).toBe(true);
    expect(r2.json().data.doneAt).toBe(clock.t - 1000);

    // 取消打勾清空
    clock.t += 1000;
    const r3 = await patch(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie, {
      done: false,
      updatedAt: r2.json().data.updatedAt,
    });
    expect(r3.json().data.done).toBe(false);
    expect(r3.json().data.doneAt).toBeNull();
    expect(r3.json().data.doneBy).toBeNull();

    // 库核对
    const row = tmp.sqlite
      .prepare("SELECT done, done_at, done_by FROM delivery_tasks WHERE id = ?")
      .get(task.id) as { done: number; done_at: number | null; done_by: number | null };
    expect(row.done).toBe(0);
    expect(row.done_at).toBeNull();
    expect(row.done_by).toBeNull();
  });

  it("任务行级 OCC：同一 updatedAt 二次 PATCH → 409；DELETE 硬删；软删交付项后任务端点 404", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin();
    const task = d.tasks[0];

    clock.t += 1000;
    const r1 = await patch(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie, {
      done: true,
      updatedAt: task.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await patch(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie, {
      done: true,
      updatedAt: task.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");

    // 硬删：表里不再有该行；GET 交付项任务数组少一条
    expect((await del(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie)).statusCode).toBe(204);
    expect(tasksOf(d.id)).toHaveLength(1);
    expect((await get(`/api/v1/deliverables/${d.id}`, cookie)).json().data.tasks).toHaveLength(1);
    expect((await del(`/api/v1/deliverables/${d.id}/tasks/${task.id}`, cookie)).statusCode).toBe(404);

    // 软删交付项后任务端点 404
    await del(`/api/v1/deliverables/${d.id}`, cookie);
    expect((await post(`/api/v1/deliverables/${d.id}/tasks`, cookie, { content: "x" })).statusCode).toBe(404);
    const t2 = d.tasks[1];
    expect(
      (await patch(`/api/v1/deliverables/${d.id}/tasks/${t2.id}`, cookie, { done: true, updatedAt: t2.updatedAt }))
        .statusCode,
    ).toBe(404);
  });
});

describe("GET /api/v1/deliverables/:id 与 DELETE", () => {
  it("GET：软删/不存在 → 404；非法 id → 422。DELETE：204；重复删除 → 404", async () => {
    const { cookie, data: d } = await createDeliverableAsAdmin();
    expect((await get("/api/v1/deliverables/9999", cookie)).statusCode).toBe(404);
    expect((await get("/api/v1/deliverables/abc", cookie)).statusCode).toBe(422);

    expect((await del(`/api/v1/deliverables/${d.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/deliverables/${d.id}`, cookie)).statusCode).toBe(404);
    expect((await del(`/api/v1/deliverables/${d.id}`, cookie)).statusCode).toBe(404);
  });
});
