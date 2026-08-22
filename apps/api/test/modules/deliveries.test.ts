// deliveries 域测试（K44）：类型配置表 / 交付单（客户集合）/ 交付项（双维度模板预填）/ 动作任务。
// inject + loginAs，假时钟控 updatedAt；PATCH 走 lib/patch-kernel.ts。
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

function seedDeal(db: Db, customerId: number, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(deals)
      .values({ customerId, orderNo: "ORD-D", createdAt: now, updatedAt: now, ...extra } as never)
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

const tasksOf = (itemId: number): { customer_id: number | null; content: string; done: number }[] =>
  tmp.sqlite
    .prepare("SELECT customer_id, content, done FROM delivery_tasks WHERE deliverable_id = ? ORDER BY id")
    .all(itemId) as { customer_id: number | null; content: string; done: number }[];

/** 建一个带模板的类型 + 含 N 个客户的交付单；返回 id 集合 */
let adminSeq = 0;
async function seedTypeAndDelivery(customerCount = 2, typeExtra: JsonBody = {}) {
  const { id: adminId, cookie } = await loginAsRole("admin", `u-admin-${adminSeq++}`);
  const typeRes = await post("/api/v1/delivery-types", cookie, {
    name: "圈子全年交付",
    defaultTasks: "拉群\n商品发货",
    ...typeExtra,
  });
  expect(typeRes.statusCode).toBe(201);
  const typeId = typeRes.json().data.id;

  const customerIds = Array.from({ length: customerCount }, (_, i) =>
    seedCustomer(tmp.db, `客户${i + 1}`),
  );
  const dRes = await post("/api/v1/deliveries", cookie, {
    deliveryTypeId: typeId,
    customerIds,
    remark: "交付备注",
  });
  expect(dRes.statusCode).toBe(201);
  return { adminId, cookie, typeId, customerIds, delivery: dRes.json().data };
}

describe("RBAC（K44：deliveries 统一 resource，assistant 只读）", () => {
  it("assistant：全部端点 list/read 200，写 403", async () => {
    const { typeId, delivery } = await seedTypeAndDelivery();
    const { cookie: aCookie } = await loginAsRole("assistant");

    expect((await get("/api/v1/delivery-types", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/delivery-types/${typeId}`, aCookie)).statusCode).toBe(200);
    expect((await get("/api/v1/deliveries", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/deliveries/${delivery.id}`, aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/deliveries/${delivery.id}/items`, aCookie)).statusCode).toBe(200);

    expect((await post("/api/v1/delivery-types", aCookie, { name: "x" })).statusCode).toBe(403);
    expect((await post("/api/v1/deliveries", aCookie, { deliveryTypeId: typeId, customerIds: [1] })).statusCode).toBe(403);
    expect(
      (await post(`/api/v1/deliveries/${delivery.id}/items`, aCookie, { content: "x" })).statusCode,
    ).toBe(403);
    expect(
      (await patch(`/api/v1/deliveries/${delivery.id}`, aCookie, { remark: "x", updatedAt: delivery.updatedAt }))
        .statusCode,
    ).toBe(403);
  });

  it("operator/admin 全通", async () => {
    const { cookie: opCookie } = await loginAsRole("operator");
    const c1 = seedCustomer(tmp.db, "运营客户");
    const typeRes = await post("/api/v1/delivery-types", opCookie, { name: "1v1咨询" });
    const typeId = typeRes.json().data.id;
    const created = await post("/api/v1/deliveries", opCookie, {
      deliveryTypeId: typeId,
      customerIds: [c1],
    });
    expect(created.statusCode).toBe(201);
    const d = created.json().data;
    const item = await post(`/api/v1/deliveries/${d.id}/items`, opCookie, { content: "交付说明" });
    expect(item.statusCode).toBe(201);
    expect((await del(`/api/v1/deliveries/${d.id}`, opCookie)).statusCode).toBe(204);
  });
});

describe("delivery-types 配置表", () => {
  it("CRUD：分类 kind/状态 status + 默认动作模板读写；PATCH 只改一列；软删", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/delivery-types", cookie, {
      name: "线上连麦",
      kind: "activity",
      status: "active",
      description: "直播类",
      defaultTasks: "建直播间\n预告",
    });
    expect(created.statusCode).toBe(201);
    const t = created.json().data;
    expect(t.kind).toBe("activity");
    expect(t.status).toBe("active");
    expect(t.defaultTasks).toBe("建直播间\n预告");

    clock.t += 1000;
    const updated = await patch(`/api/v1/delivery-types/${t.id}`, cookie, {
      status: "inactive",
      description: "直播+录播",
      updatedAt: t.updatedAt,
    });
    expect(updated.json().data.status).toBe("inactive");
    expect(updated.json().data.kind).toBe("activity");
    expect(updated.json().data.description).toBe("直播+录播");
    expect(updated.json().data.defaultTasks).toBe("建直播间\n预告");

    expect((await del(`/api/v1/delivery-types/${t.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/delivery-types/${t.id}`, cookie)).statusCode).toBe(404);
  });

  it("新建不传 kind/status → 默认 other/active；非法枚举 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/delivery-types", cookie, { name: "默认分类" });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.kind).toBe("other");
    expect(created.json().data.status).toBe("active");

    expect(
      (await post("/api/v1/delivery-types", cookie, { name: "x", kind: "bogus" })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/delivery-types", cookie, { name: "x", status: "bogus" })).statusCode,
    ).toBe(422);
  });

  it("删除被交付单引用的类型 → 422；q 搜 name/description", async () => {
    const { cookie, typeId } = await seedTypeAndDelivery();
    const delRes = await del(`/api/v1/delivery-types/${typeId}`, cookie);
    expect(delRes.statusCode).toBe(422);

    const byQ = await get("/api/v1/delivery-types?q=" + encodeURIComponent("圈子"), cookie);
    expect(byQ.json().meta.total).toBe(1);
    const none = await get("/api/v1/delivery-types?q=" + encodeURIComponent("不存在"), cookie);
    expect(none.json().meta.total).toBe(0);
  });
});

describe("deliveries 交付单", () => {
  it("创建：类型必填；客户可空（空交付单）；客户/类型不存在 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/deliveries", cookie, {})).statusCode).toBe(422);
    const typeId = (await post("/api/v1/delivery-types", cookie, { name: "T" })).json().data.id;
    // 空客户集合允许：创建没有客户的交付单
    const empty = await post("/api/v1/deliveries", cookie, { deliveryTypeId: typeId, customerIds: [] });
    expect(empty.statusCode).toBe(201);
    expect(empty.json().data.customers).toEqual([]);
    expect((await post("/api/v1/deliveries", cookie, { deliveryTypeId: 9999, customerIds: [1] })).statusCode).toBe(422);
    expect((await post("/api/v1/deliveries", cookie, { deliveryTypeId: typeId, customerIds: [9999] })).statusCode).toBe(422);
  });

  it("起止日期：创建读写；PATCH 缺席不动、null 清空", async () => {
    const { cookie, typeId } = await seedTypeAndDelivery(1);
    const created = await post("/api/v1/deliveries", cookie, {
      deliveryTypeId: typeId,
      customerIds: [],
      startsAt: 1700000000000,
      endsAt: 1700600000000,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.startsAt).toBe(1700000000000);
    expect(created.json().data.endsAt).toBe(1700600000000);

    // 缺席不动
    clock.t += 1000;
    const patched = await patch(`/api/v1/deliveries/${created.json().data.id}`, cookie, {
      startsAt: 1700100000000,
      updatedAt: created.json().data.updatedAt,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.startsAt).toBe(1700100000000);
    expect(patched.json().data.endsAt).toBe(1700600000000);

    // null 清空
    clock.t += 1000;
    const cleared = await patch(`/api/v1/deliveries/${created.json().data.id}`, cookie, {
      startsAt: null,
      updatedAt: patched.json().data.updatedAt,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.startsAt).toBeNull();
    expect(cleared.json().data.endsAt).toBe(1700600000000);
  });

  it("客户集合整表替换：[] 清空 / 缺席不动；q 搜客户昵称；类型过滤", async () => {
    const { cookie, typeId, delivery, customerIds } = await seedTypeAndDelivery();
    const [c1] = customerIds;
    const c2 = seedCustomer(tmp.db, "后来客户");

    // 缺席不动
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deliveries/${delivery.id}`, cookie, { remark: "改备注", updatedAt: delivery.updatedAt });
    expect(r1.json().data.customers.map((c: { id: number }) => c.id)).toEqual(customerIds);

    // 整表替换为 [c1, c2]
    clock.t += 1000;
    const r2 = await patch(`/api/v1/deliveries/${delivery.id}`, cookie, {
      customerIds: [c1, c2],
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.json().data.customers).toHaveLength(2);
    expect(r2.json().data.customers.map((c: { id: number }) => c.id).sort()).toEqual([c1, c2].sort());

    // q 搜客户昵称 + 类型/客户过滤
    const byQ = await get("/api/v1/deliveries?q=" + encodeURIComponent("客户1"), cookie);
    expect(byQ.json().meta.total).toBe(1);
    const byType = await get(`/api/v1/deliveries?deliveryTypeId=${typeId}`, cookie);
    expect(byType.json().meta.total).toBe(1);
    expect((await get(`/api/v1/deliveries?customerId=${c1}`, cookie)).json().meta.total).toBe(1);

    // [] 清空
    clock.t += 1000;
    const r3 = await patch(`/api/v1/deliveries/${delivery.id}`, cookie, {
      customerIds: [],
      updatedAt: r2.json().data.updatedAt,
    });
    expect(r3.json().data.customers).toEqual([]);
  });

  it("软删：列表不出现、GET 404、重复删除 404", async () => {
    const { cookie, delivery } = await seedTypeAndDelivery();
    expect((await get("/api/v1/deliveries", cookie)).json().meta.total).toBe(1);
    expect((await del(`/api/v1/deliveries/${delivery.id}`, cookie)).statusCode).toBe(204);
    expect((await get("/api/v1/deliveries", cookie)).json().meta.total).toBe(0);
    expect((await get(`/api/v1/deliveries/${delivery.id}`, cookie)).statusCode).toBe(404);
    expect((await del(`/api/v1/deliveries/${delivery.id}`, cookie)).statusCode).toBe(404);
  });
});

describe("deliverables 交付项（双维度 + 类型模板预填）", () => {
  it("项目维度：按类型 default_tasks 预填一组任务（customer_id NULL）", async () => {
    const { cookie, delivery } = await seedTypeAndDelivery();
    const res = await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, { content: "圈子交付" });
    expect(res.statusCode).toBe(201);
    const item = res.json().data;
    expect(item.dimension).toBe("project");
    expect(item.tasks.map((t: { content: string }) => t.content)).toEqual(["拉群", "商品发货"]);
    expect(item.tasks.every((t: { done: boolean }) => t.done === false)).toBe(true);
    expect(tasksOf(item.id).map((r) => r.content)).toEqual(["拉群", "商品发货"]);
    expect(tasksOf(item.id).every((r) => r.customer_id === null)).toBe(true);
  });

  it("客户维度：默认全部客户，每个客户各一组任务；部分选择只生成选中客户", async () => {
    const { cookie, delivery, customerIds } = await seedTypeAndDelivery(3);
    // 全部（省略 customerIds）
    const allRes = await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, {
      content: "拉群",
      dimension: "customer",
    });
    expect(allRes.statusCode).toBe(201);
    const allItem = allRes.json().data;
    expect(allItem.tasks).toHaveLength(3 * 2); // 3 客户 × 2 模板动作
    const customers = new Set(allItem.tasks.map((t: { customer: { id: number } | null }) => t.customer?.id));
    expect(customers.size).toBe(3);

    // 部分选择
    const partial = await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, {
      content: "发货",
      dimension: "customer",
      customerIds: [customerIds[0]],
    });
    const partialItem = partial.json().data;
    expect(partialItem.tasks).toHaveLength(2);
    expect(partialItem.tasks.every((t: { customer: { id: number } }) => t.customer.id === customerIds[0])).toBe(true);

    // 选择不在交付客户集合内的客户 → 422
    const outsider = seedCustomer(tmp.db, "外部客户");
    expect(
      (await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, {
        content: "x",
        dimension: "customer",
        customerIds: [outsider],
      })).statusCode,
    ).toBe(422);
  });

  it("无模板类型 → 空任务；content 必填；软删交付项", async () => {
    const { cookie, delivery } = await seedTypeAndDelivery(1, { defaultTasks: null });
    const res = await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, { content: "纯说明" });
    expect(res.json().data.tasks).toEqual([]);
    expect((await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, { content: "" })).statusCode).toBe(422);

    const item = res.json().data;
    expect((await del(`/api/v1/deliveries/${delivery.id}/items/${item.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/deliveries/${delivery.id}/items`, cookie)).json().data).toHaveLength(0);
  });

  it("PATCH 交付项：只改 content/description/deliveryUrl；OCC 409", async () => {
    const { cookie, delivery } = await seedTypeAndDelivery();
    const item = (await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, { content: "原内容", deliveryUrl: "https://a" })).json().data;
    clock.t += 1000;
    const r1 = await patch(`/api/v1/deliveries/${delivery.id}/items/${item.id}`, cookie, {
      content: "新内容",
      updatedAt: item.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.content).toBe("新内容");
    expect(r1.json().data.deliveryUrl).toBe("https://a");
    expect(r1.json().data.tasks).toHaveLength(2); // 任务不受影响

    const r2 = await patch(`/api/v1/deliveries/${delivery.id}/items/${item.id}`, cookie, {
      content: "再改",
      updatedAt: item.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
  });
});

describe("delivery_tasks 动作清单", () => {
  it("客户维度：打勾/备注互不干扰；done 翻转记 doneAt/doneBy", async () => {
    const { adminId, cookie, delivery, customerIds } = await seedTypeAndDelivery(2);
    const item = (await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, {
      content: "拉群",
      dimension: "customer",
    })).json().data;
    const taskA = item.tasks.find((t: { customer: { id: number } }) => t.customer.id === customerIds[0]);

    clock.t += 1000;
    const rA = await patch(`/api/v1/deliveries/${delivery.id}/items/${item.id}/tasks/${taskA.id}`, cookie, {
      done: true,
      remark: "A 已进群",
      updatedAt: taskA.updatedAt,
    });
    expect(rA.statusCode).toBe(200);
    expect(rA.json().data.done).toBe(true);
    expect(rA.json().data.doneAt).toBe(clock.t);
    expect(rA.json().data.doneBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(rA.json().data.remark).toBe("A 已进群");

    // 客户 B 不受影响（B 是另一条任务）
    const rB = await get(`/api/v1/deliveries/${delivery.id}/items`, cookie);
    const bTask = rB.json().data
      .find((x: { id: number }) => x.id === item.id)
      .tasks.find((t: { customer: { id: number } }) => t.customer.id === customerIds[1]);
    expect(bTask.done).toBe(false);
    expect(bTask.remark).toBeNull();

    // 取消打勾清空 doneAt/doneBy
    clock.t += 1000;
    const rA2 = await patch(`/api/v1/deliveries/${delivery.id}/items/${item.id}/tasks/${taskA.id}`, cookie, {
      done: false,
      updatedAt: rA.json().data.updatedAt,
    });
    expect(rA2.json().data.done).toBe(false);
    expect(rA2.json().data.doneAt).toBeNull();
    expect(rA2.json().data.doneBy).toBeNull();
    expect(rA2.json().data.remark).toBe("A 已进群"); // 备注保留
  });

  it("任务 OCC 409；硬删；客户校验（非交付客户 → 422；项目维度带客户 → 422）", async () => {
    const { cookie, delivery } = await seedTypeAndDelivery(2);
    const projectItem = (await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, { content: "P" })).json().data;
    const customerItem = (await post(`/api/v1/deliveries/${delivery.id}/items`, cookie, {
      content: "C",
      dimension: "customer",
    })).json().data;

    // 项目维度任务带 customerId → 422
    expect(
      (await post(`/api/v1/deliveries/${delivery.id}/items/${projectItem.id}/tasks`, cookie, {
        content: "x",
        customerId: 1,
      })).statusCode,
    ).toBe(422);
    // 客户维度任务缺 customerId → 422
    expect(
      (await post(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks`, cookie, {
        content: "x",
      })).statusCode,
    ).toBe(422);
    // 客户维度任务指定非交付客户 → 422
    const outsider = seedCustomer(tmp.db, "外来客户");
    expect(
      (await post(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks`, cookie, {
        content: "x",
        customerId: outsider,
      })).statusCode,
    ).toBe(422);

    // 追加一个客户维度任务（合法）
    const c1 = (await get(`/api/v1/deliveries/${delivery.id}`, cookie)).json().data.customers[0].id;
    const added = await post(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks`, cookie, {
      content: "额外动作",
      customerId: c1,
    });
    expect(added.statusCode).toBe(201);

    // OCC：同 updatedAt 二次 → 409
    const task = added.json().data;
    clock.t += 1000;
    const p1 = await patch(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks/${task.id}`, cookie, {
      done: true,
      updatedAt: task.updatedAt,
    });
    expect(p1.statusCode).toBe(200);
    const p2 = await patch(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks/${task.id}`, cookie, {
      done: true,
      updatedAt: task.updatedAt,
    });
    expect(p2.statusCode).toBe(409);

    // 硬删
    expect(
      (await del(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks/${task.id}`, cookie)).statusCode,
    ).toBe(204);
    expect(
      (await del(`/api/v1/deliveries/${delivery.id}/items/${customerItem.id}/tasks/${task.id}`, cookie)).statusCode,
    ).toBe(404);
  });
});

describe("deals productId/productType 过滤（K44 按意向产品 merge 客户依赖）", () => {
  it("productType=knowledge 只返回该类型产品的成交", async () => {
    const { cookie } = await loginAsRole("admin");
    const c1 = seedCustomer(tmp.db, "客户1");
    const c2 = seedCustomer(tmp.db, "客户2");
    const pK = seedProduct(tmp.db, "知识产品", { productType: "knowledge" });
    const pC = seedProduct(tmp.db, "咨询产品", { productType: "c_consulting" });
    seedDeal(tmp.db, c1, { productId: pK, orderNo: "ORD-K" });
    seedDeal(tmp.db, c2, { productId: pC, orderNo: "ORD-C" });

    const res = await get("/api/v1/deals?productType=knowledge&pageSize=100", cookie);
    expect(res.json().meta.total).toBe(1);
    expect(res.json().data[0].orderNo).toBe("ORD-K");
    expect((await get("/api/v1/deals?productType=bogus", cookie)).statusCode).toBe(422);
  });
});
