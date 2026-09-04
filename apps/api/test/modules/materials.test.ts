// K54 交付资料（materials）：CRUD + kind↔content/url 组合校验 + FTS5/LIKE 混合搜索 +
// kind/deliveryId/customerId/orphan 过滤 + PATCH 内核（K24）+ OCC + 软删 + RBAC。
// inject + loginAs，假时钟控 updatedAt；delivery/customer 依赖走 API 种子。
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

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) =>
  app.inject({ method: "DELETE", url, headers: { cookie } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Material = any;

async function createCustomer(cookie: string, nickname: string): Promise<number> {
  const res = await post("/api/v1/customers", cookie, { nickname });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

async function createDelivery(cookie: string): Promise<{ id: number; startsAt: number; endsAt: number }> {
  const type = await post("/api/v1/delivery-types", cookie, { name: "一对一咨询", kind: "consulting" });
  expect(type.statusCode).toBe(201);
  const res = await post("/api/v1/deliveries", cookie, {
    deliveryTypeId: type.json().data.id,
    customerIds: [],
    startsAt: clock.t - 1000,
    endsAt: clock.t + 100000,
  });
  expect(res.statusCode).toBe(201);
  const data = res.json().data;
  return { id: data.id, startsAt: data.startsAt, endsAt: data.endsAt };
}

async function createMaterial(cookie: string, payload: JsonBody): Promise<Material> {
  const res = await post("/api/v1/materials", cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

const TEXT = { kind: "text", title: "咨询录音整理稿", content: "本次复盘会议纪要全文如下：客户诉求与行动项。" };
const AUDIO = { kind: "audio", title: "线下沙龙录音", url: "https://example.com/a.mp3" };

describe("RBAC（materials 资源，K54）", () => {
  it("assistant：list/read 200；create/update/delete 403；未登录 401", async () => {
    const admin = await loginAsRole("admin");
    const m = await createMaterial(admin.cookie, TEXT);

    const asst = await loginAsRole("assistant");
    expect((await get("/api/v1/materials", asst.cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/materials/${m.id}`, asst.cookie)).statusCode).toBe(200);
    expect((await post("/api/v1/materials", asst.cookie, TEXT)).statusCode).toBe(403);
    expect(
      (await patch(`/api/v1/materials/${m.id}`, asst.cookie, { title: "x", updatedAt: m.updatedAt }))
        .statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/materials/${m.id}`, asst.cookie)).statusCode).toBe(403);

    expect((await app.inject({ method: "GET", url: "/api/v1/materials" })).statusCode).toBe(401);
  });

  it("operator 全量可写", async () => {
    const op = await loginAsRole("operator");
    const res = await post("/api/v1/materials", op.cookie, TEXT);
    expect(res.statusCode).toBe(201);
    const m = res.json().data;
    clock.t += 1000;
    expect(
      (await patch(`/api/v1/materials/${m.id}`, op.cookie, { title: "改名", updatedAt: m.updatedAt }))
        .statusCode,
    ).toBe(200);
    expect((await del(`/api/v1/materials/${m.id}`, op.cookie)).statusCode).toBe(204);
  });
});

describe("POST /api/v1/materials 创建", () => {
  it("文本类 content 可空（创建后全文编辑器补写）；媒体类 url 必填 → 422 VALIDATION", async () => {
    const { cookie } = await loginAsRole("admin");
    // 文本类空 content → 201，content=null / contentLength=0 / excerpt=null
    const noContent = await post("/api/v1/materials", cookie, { kind: "text", title: "无内容" });
    expect(noContent.statusCode).toBe(201);
    expect(noContent.json().data.content).toBeNull();
    expect(noContent.json().data.contentLength).toBe(0);

    const emptyContent = await post("/api/v1/materials", cookie, {
      kind: "transcript",
      title: "空串内容",
      content: "",
    });
    expect(emptyContent.statusCode).toBe(201);

    const noUrl = await post("/api/v1/materials", cookie, { kind: "video", title: "无链接" });
    expect(noUrl.statusCode).toBe(422);
    expect(noUrl.json().error.code).toBe("VALIDATION");

    const ok = await post("/api/v1/materials", cookie, {
      kind: "link",
      title: "外部文章",
      url: "https://example.com/post",
    });
    expect(ok.statusCode).toBe(201);
    // 详情 DTO：媒体类 content=null、contentLength=0、excerpt=null
    expect(ok.json().data.content).toBeNull();
    expect(ok.json().data.contentLength).toBe(0);
    expect(ok.json().data.excerpt).toBeNull();
  });

  it("关联展开：delivery（含 deliveryType/startsAt/endsAt）与 customers；审计列展开", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const delivery = await createDelivery(cookie);
    const c1 = await createCustomer(cookie, "客户甲");
    const c2 = await createCustomer(cookie, "客户乙");

    const res = await post("/api/v1/materials", cookie, {
      ...TEXT,
      deliveryId: delivery.id,
      customerIds: [c1, c2],
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.deliveryId).toBe(delivery.id);
    expect(data.delivery).toEqual({
      id: delivery.id,
      deliveryType: { id: expect.any(Number), name: "一对一咨询", kind: "consulting" },
      startsAt: delivery.startsAt,
      endsAt: delivery.endsAt,
    });
    expect(data.customers).toEqual([
      { id: c1, nickname: "客户甲" },
      { id: c2, nickname: "客户乙" },
    ]);
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(data.content).toBe(TEXT.content);
  });

  it("deliveryId 指向不存在/已软删交付 → 422；customerIds 含不存在/已删客户 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const delivery = await createDelivery(cookie);
    expect((await del(`/api/v1/deliveries/${delivery.id}`, cookie)).statusCode).toBe(204);

    expect(
      (await post("/api/v1/materials", cookie, { ...TEXT, deliveryId: delivery.id })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/materials", cookie, { ...TEXT, deliveryId: 9999 })).statusCode,
    ).toBe(422);

    const cid = await createCustomer(cookie, "将删客户");
    expect((await del(`/api/v1/customers/${cid}`, cookie)).statusCode).toBe(204);
    expect(
      (await post("/api/v1/materials", cookie, { ...TEXT, customerIds: [cid] })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/materials", cookie, { ...TEXT, customerIds: [9999] })).statusCode,
    ).toBe(422);
  });
});

describe("GET /api/v1/materials 列表：搜索（FTS/LIKE 混合）", () => {
  it("≥3 字符 token 走 FTS：命中 title 与 content；2 字符 token 回退 LIKE；多 token AND；软删搜不到", async () => {
    const { cookie } = await loginAsRole("admin");
    const m1 = await createMaterial(cookie, TEXT); // title 咨询录音整理稿 / content …会议纪要…
    await createMaterial(cookie, AUDIO); // title 线下沙龙录音
    await createMaterial(cookie, {
      kind: "text",
      title: "产品使用问题汇总",
      content: "客户反馈的产品问题清单",
    });

    // FTS：title 命中（4 字符）
    const byTitle = await get(`/api/v1/materials?q=${encodeURIComponent("录音整理")}`, cookie);
    expect(byTitle.json().meta.total).toBe(1);
    expect(byTitle.json().data[0].id).toBe(m1.id);

    // FTS：content 命中（4 字符）
    const byContent = await get(`/api/v1/materials?q=${encodeURIComponent("会议纪要")}`, cookie);
    expect(byContent.json().meta.total).toBe(1);
    expect(byContent.json().data[0].id).toBe(m1.id);

    // LIKE 回退：2 字符 token（trigram 不命中，走 LIKE）
    const short = await get(`/api/v1/materials?q=${encodeURIComponent("咨询")}`, cookie);
    expect(short.json().meta.total).toBe(1);
    expect(short.json().data[0].id).toBe(m1.id);

    // 多 token AND：两个 2 字符 token 都命中同一行 title
    const andRes = await get(
      `/api/v1/materials?q=${encodeURIComponent("录音 沙龙")}`,
      cookie,
    );
    expect(andRes.json().meta.total).toBe(1);
    expect(andRes.json().data[0].title).toBe("线下沙龙录音");

    // 混合：FTS token + LIKE token 共同 AND
    const mixed = await get(
      `/api/v1/materials?q=${encodeURIComponent("录音整理 纪要")}`,
      cookie,
    );
    expect(mixed.json().meta.total).toBe(1);
    expect(mixed.json().data[0].id).toBe(m1.id);

    // AND 不满足 → 0
    const none = await get(
      `/api/v1/materials?q=${encodeURIComponent("录音整理 沙龙")}`,
      cookie,
    );
    expect(none.json().meta.total).toBe(0);

    // 软删后搜不到（FTS 触发器同步移出索引）
    expect((await del(`/api/v1/materials/${m1.id}`, cookie)).statusCode).toBe(204);
    const afterDelete = await get(`/api/v1/materials?q=${encodeURIComponent("录音整理")}`, cookie);
    expect(afterDelete.json().meta.total).toBe(0);
    const afterDeleteLike = await get(`/api/v1/materials?q=${encodeURIComponent("咨询")}`, cookie);
    expect(afterDeleteLike.json().meta.total).toBe(0);
  });

  it("PATCH 改 content/title 后 FTS 更新触发器同步：新词可搜到、旧词搜不到", async () => {
    const { cookie } = await loginAsRole("admin");
    const m = await createMaterial(cookie, {
      kind: "text",
      title: "旧词阿尔法记录",
      content: "原始语料包含贝塔伽马内容",
    });
    expect(
      (await get(`/api/v1/materials?q=${encodeURIComponent("贝塔伽马")}`, cookie)).json().meta
        .total,
    ).toBe(1);

    clock.t += 1000;
    const res = await patch(`/api/v1/materials/${m.id}`, cookie, {
      title: "新词德尔塔记录",
      content: "改写后的语料只有西格玛要点",
      updatedAt: m.updatedAt,
    });
    expect(res.statusCode).toBe(200);

    // 新词命中（content 与 title 各一条路径）
    for (const q of ["西格玛", "德尔塔"]) {
      const hit = await get(`/api/v1/materials?q=${encodeURIComponent(q)}`, cookie);
      expect(hit.json().meta.total).toBe(1);
      expect(hit.json().data[0].id).toBe(m.id);
    }
    // 旧词不再命中
    for (const q of ["贝塔伽马", "阿尔法"]) {
      const miss = await get(`/api/v1/materials?q=${encodeURIComponent(q)}`, cookie);
      expect(miss.json().meta.total).toBe(0);
    }
  });

  it("kind / deliveryId / customerId 过滤", async () => {
    const { cookie } = await loginAsRole("admin");
    const delivery = await createDelivery(cookie);
    const cid = await createCustomer(cookie, "过滤客户");

    const t = await createMaterial(cookie, { ...TEXT, deliveryId: delivery.id, customerIds: [cid] });
    await createMaterial(cookie, AUDIO);

    const byKind = await get("/api/v1/materials?kind=audio", cookie);
    expect(byKind.json().meta.total).toBe(1);
    expect(byKind.json().data[0].kind).toBe("audio");

    const byDelivery = await get(`/api/v1/materials?deliveryId=${delivery.id}`, cookie);
    expect(byDelivery.json().meta.total).toBe(1);
    expect(byDelivery.json().data[0].id).toBe(t.id);

    const byCustomer = await get(`/api/v1/materials?customerId=${cid}`, cookie);
    expect(byCustomer.json().meta.total).toBe(1);
    expect(byCustomer.json().data[0].id).toBe(t.id);
  });

  it("deliveryKind 过滤：consulting/activity/circle 只命中对应类；other=未关联或类型为 other；交付软删归 other；非法值 422", async () => {
    const { cookie } = await loginAsRole("admin");

    const makeType = async (name: string, kind: string): Promise<number> => {
      const res = await post("/api/v1/delivery-types", cookie, { name, kind });
      expect(res.statusCode).toBe(201);
      return res.json().data.id;
    };
    const makeDelivery = async (typeId: number): Promise<number> => {
      const res = await post("/api/v1/deliveries", cookie, {
        deliveryTypeId: typeId,
        customerIds: [],
        startsAt: clock.t - 1000,
        endsAt: clock.t + 100000,
      });
      expect(res.statusCode).toBe(201);
      return res.json().data.id;
    };

    const consultingDelivery = await makeDelivery(await makeType("一对一咨询", "consulting"));
    const activityDelivery = await makeDelivery(await makeType("线下沙龙", "activity"));
    const circleDelivery = await makeDelivery(await makeType("年度圈子", "circle"));
    const otherDelivery = await makeDelivery(await makeType("其它服务", "other"));

    const consulting = await createMaterial(cookie, { ...TEXT, title: "咨询类资料", deliveryId: consultingDelivery });
    const activity = await createMaterial(cookie, { ...TEXT, title: "活动类资料", deliveryId: activityDelivery });
    const circle = await createMaterial(cookie, { ...TEXT, title: "圈子类资料", deliveryId: circleDelivery });
    const other = await createMaterial(cookie, { ...TEXT, title: "其他类资料", deliveryId: otherDelivery });
    const orphan = await createMaterial(cookie, { kind: "text", title: "孤儿资料", content: "无交付" });

    const getIds = async (kind: string): Promise<number[]> => {
      const res = await get(`/api/v1/materials?deliveryKind=${kind}&pageSize=100`, cookie);
      expect(res.statusCode).toBe(200);
      return (res.json().data as Material[]).map((m) => m.id);
    };

    // 三种明确分类互不串
    expect(await getIds("consulting")).toEqual([consulting.id]);
    expect(await getIds("activity")).toEqual([activity.id]);
    expect(await getIds("circle")).toEqual([circle.id]);

    // other = 类型为 other 的资料 + 未关联孤儿；不含明确分类
    const otherIds = await getIds("other");
    expect(otherIds).toContain(other.id);
    expect(otherIds).toContain(orphan.id);
    expect(otherIds).not.toContain(consulting.id);
    expect(otherIds).not.toContain(activity.id);

    // 交付软删 → 展开为 null（未关联）→ 归 other
    expect((await del(`/api/v1/deliveries/${circleDelivery}`, cookie)).statusCode).toBe(204);
    expect(await getIds("circle")).not.toContain(circle.id);
    expect(await getIds("other")).toContain(circle.id);

    // 非法值 → 422 VALIDATION
    expect((await get("/api/v1/materials?deliveryKind=invalid", cookie)).statusCode).toBe(422);
  });

  it("orphan=1：无交付单或无客户即孤儿；两者都有不出现", async () => {
    const { cookie } = await loginAsRole("admin");
    const delivery = await createDelivery(cookie);
    const cid = await createCustomer(cookie, "孤儿客户");

    const neither = await createMaterial(cookie, { kind: "text", title: "全无", content: "无交付无客户" });
    const deliveryOnly = await createMaterial(cookie, {
      kind: "text",
      title: "只有交付",
      content: "挂交付无客户",
      deliveryId: delivery.id,
    });
    const customerOnly = await createMaterial(cookie, {
      kind: "text",
      title: "只有客户",
      content: "挂客户无交付",
      customerIds: [cid],
    });
    const full = await createMaterial(cookie, {
      kind: "text",
      title: "完整关联",
      content: "交付客户都有",
      deliveryId: delivery.id,
      customerIds: [cid],
    });

    const res = await get("/api/v1/materials?orphan=1&pageSize=100", cookie);
    const ids = (res.json().data as Material[]).map((m) => m.id);
    expect(ids).toContain(neither.id);
    expect(ids).toContain(deliveryOnly.id);
    expect(ids).toContain(customerOnly.id);
    expect(ids).not.toContain(full.id);
  });

  it("列表项不含 content 键；有 contentLength/excerpt（前 100 字符）；分页 meta；camelCase", async () => {
    const { cookie } = await loginAsRole("admin");
    const longContent = "长".repeat(150);
    const m = await createMaterial(cookie, { kind: "text", title: "长文", content: longContent });
    for (let i = 0; i < 29; i++) {
      await createMaterial(cookie, { kind: "link", title: `链接-${i}`, url: `https://e.com/${i}` });
    }

    const page1 = await get("/api/v1/materials?page=1&pageSize=25", cookie);
    expect(page1.statusCode).toBe(200);
    expect(page1.json().meta).toEqual({ page: 1, pageSize: 25, total: 30 });
    expect(page1.json().data).toHaveLength(25);

    const page2 = await get("/api/v1/materials?page=2&pageSize=25", cookie);
    expect(page2.json().data).toHaveLength(5);

    const byTitle = await get(`/api/v1/materials?q=${encodeURIComponent("长文")}`, cookie);
    const item = byTitle.json().data[0];
    expect(item.id).toBe(m.id);
    expect("content" in item).toBe(false);
    expect(item.contentLength).toBe(150);
    expect(item.excerpt).toBe("长".repeat(100));

    // GET :id 返回完整 content
    const detail = await get(`/api/v1/materials/${m.id}`, cookie);
    expect(detail.json().data.content).toBe(longContent);
    expect(detail.json().data.contentLength).toBe(150);

    const raw = JSON.stringify(page1.json());
    expect(raw).not.toContain("deleted_at");
    expect(raw).not.toContain("created_at");
  });

  it("sort=title&order=asc 生效", async () => {
    const { cookie } = await loginAsRole("admin");
    await createMaterial(cookie, { kind: "link", title: "乙", url: "https://e.com/b" });
    await createMaterial(cookie, { kind: "link", title: "甲", url: "https://e.com/a" });
    const res = await get("/api/v1/materials?sort=title&order=asc", cookie);
    const titles = (res.json().data as Material[]).map((m) => m.title);
    expect(titles).toEqual([...titles].sort());
  });
});

describe("GET /api/v1/materials/:id", () => {
  it("404：不存在/已软删；交付软删后展开为 null", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await get("/api/v1/materials/9999", cookie)).statusCode).toBe(404);

    const delivery = await createDelivery(cookie);
    const m = await createMaterial(cookie, { ...TEXT, deliveryId: delivery.id });
    expect((await del(`/api/v1/deliveries/${delivery.id}`, cookie)).statusCode).toBe(204);

    const res = await get(`/api/v1/materials/${m.id}`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deliveryId).toBe(delivery.id);
    expect(res.json().data.delivery).toBeNull();

    expect((await del(`/api/v1/materials/${m.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/materials/${m.id}`, cookie)).statusCode).toBe(404);
  });
});

describe("PATCH /api/v1/materials/:id 内核（K24）", () => {
  it("键缺席不动；deliveryId:null 清回孤儿；customerIds:[] 清空", async () => {
    const { cookie } = await loginAsRole("admin");
    const delivery = await createDelivery(cookie);
    const cid = await createCustomer(cookie, "资料客户");
    const m = await createMaterial(cookie, { ...TEXT, deliveryId: delivery.id, customerIds: [cid] });

    clock.t += 1000;
    const r1 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      title: "只改标题",
      updatedAt: m.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.title).toBe("只改标题");
    expect(r1.json().data.content).toBe(TEXT.content); // 缺席不动
    expect(r1.json().data.delivery).not.toBeNull();
    expect(r1.json().data.customers).toHaveLength(1);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      deliveryId: null,
      customerIds: [],
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.deliveryId).toBeNull();
    expect(r2.json().data.delivery).toBeNull();
    expect(r2.json().data.customers).toEqual([]);

    // 清完后成为孤儿
    const orphan = await get("/api/v1/materials?orphan=1", cookie);
    expect((orphan.json().data as Material[]).map((x) => x.id)).toContain(m.id);
  });

  it("合并后重跑 kind↔url 组合校验：只改 kind 违反 → 422；补 url 后 → 200；文本类清空 content → 200", async () => {
    const { cookie } = await loginAsRole("admin");
    const m = await createMaterial(cookie, TEXT);

    clock.t += 1000;
    const bad = await patch(`/api/v1/materials/${m.id}`, cookie, {
      kind: "audio",
      updatedAt: m.updatedAt,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("VALIDATION");

    clock.t += 1000;
    const good = await patch(`/api/v1/materials/${m.id}`, cookie, {
      kind: "audio",
      url: "https://example.com/m.mp3",
      updatedAt: m.updatedAt, // 422 未写入，updatedAt 未变
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().data.kind).toBe("audio");
    expect(good.json().data.content).toBe(TEXT.content); // content 保留（PATCH 不清空）

    // 文本类清空 content → 200，持久化为 null
    clock.t += 1000;
    const clearContent = await patch(`/api/v1/materials/${m.id}`, cookie, {
      kind: "text",
      content: null,
      updatedAt: good.json().data.updatedAt,
    });
    expect(clearContent.statusCode).toBe(200);
    expect(clearContent.json().data.kind).toBe("text");
    expect(clearContent.json().data.content).toBeNull();
    expect(clearContent.json().data.contentLength).toBe(0);

    const detail = await get(`/api/v1/materials/${m.id}`, cookie);
    expect(detail.json().data.content).toBeNull();
  });

  it("PATCH 预检：deliveryId 软删交付 / customerIds 已删客户 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const delivery = await createDelivery(cookie);
    const cid = await createCustomer(cookie, "将被删");
    const m = await createMaterial(cookie, TEXT);

    expect((await del(`/api/v1/deliveries/${delivery.id}`, cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/customers/${cid}`, cookie)).statusCode).toBe(204);

    const r1 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      deliveryId: delivery.id,
      updatedAt: m.updatedAt,
    });
    expect(r1.statusCode).toBe(422);

    const r2 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      customerIds: [cid],
      updatedAt: m.updatedAt,
    });
    expect(r2.statusCode).toBe(422);
  });

  it("OCC：旧 updatedAt → 409 且 data 带当前完整行；已删 → 404；缺 updatedAt → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const m = await createMaterial(cookie, TEXT);

    clock.t += 1000;
    const r1 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      title: "第一次",
      updatedAt: m.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      title: "第二次",
      updatedAt: m.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    expect(r2.json().data.title).toBe("第一次");
    expect(r2.json().data.content).toBe(TEXT.content); // 409 data 是完整 DetailDto
    expect(r2.json().data.updatedAt).toBe(r1.json().data.updatedAt);

    expect((await del(`/api/v1/materials/${m.id}`, cookie)).statusCode).toBe(204);
    expect(
      (await patch(`/api/v1/materials/${m.id}`, cookie, { title: "x", updatedAt: 1 })).statusCode,
    ).toBe(404);
    expect(
      (await patch(`/api/v1/materials/${m.id}`, cookie, { title: "x" })).statusCode,
    ).toBe(422);
  });
});

describe("DELETE /api/v1/materials/:id 软删", () => {
  it("204；重复删除 404；列表不再出现", async () => {
    const { cookie } = await loginAsRole("admin");
    const m = await createMaterial(cookie, TEXT);

    expect((await del(`/api/v1/materials/${m.id}`, cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/materials/${m.id}`, cookie)).statusCode).toBe(404);

    const row = tmp.sqlite
      .prepare("SELECT deleted_at FROM delivery_materials WHERE id = ?")
      .get(m.id) as { deleted_at: number };
    expect(row.deleted_at).toBe(clock.t);

    const list = await get("/api/v1/materials", cookie);
    expect((list.json().data as Material[]).map((x) => x.id)).not.toContain(m.id);
  });
});

// ---- K58 资料标签 ----

async function createMaterialTag(
  cookie: string,
  name: string,
): Promise<{ id: number; name: string }> {
  const res = await post("/api/v1/tags", cookie, { name, domain: "material" });
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

describe("资料标签（K58）：创建", () => {
  it("tagIds 挂 material 域 live 词 → DTO.tags 展开；customer 域词 id → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const tag = await createMaterialTag(cookie, "逐字稿");
    const customerTag = await post("/api/v1/tags", cookie, { name: "客户域词" });
    expect(customerTag.statusCode).toBe(201);

    const res = await post("/api/v1/materials", cookie, { ...TEXT, tagIds: [tag.id] });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.tags).toEqual([{ id: tag.id, name: "逐字稿" }]);

    const bad = await post("/api/v1/materials", cookie, {
      ...TEXT,
      tagIds: [customerTag.json().data.id],
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe("VALIDATION");
  });

  it("newTagNames 自动建 material 域词（scope=other/enabled）并挂上；同名 live 资料词复用；与客户域同名互不影响", async () => {
    const { cookie } = await loginAsRole("admin");
    // 客户域已有「VIP」（domain 缺省 customer）
    const vip = await post("/api/v1/tags", cookie, { name: "VIP" });
    expect(vip.statusCode).toBe(201);
    // 资料域已有 live 词「复盘」
    const existing = await createMaterialTag(cookie, "复盘");

    const res = await post("/api/v1/materials", cookie, {
      ...TEXT,
      newTagNames: ["金句", "复盘", "VIP"],
    });
    expect(res.statusCode).toBe(201);
    const tags = res.json().data.tags as { id: number; name: string }[];
    expect(tags.map((t) => t.name).sort()).toEqual(["VIP", "复盘", "金句"].sort());
    // 「复盘」复用已有 live 词，不产生重复行
    expect(tags.find((t) => t.name === "复盘")!.id).toBe(existing.id);
    // 「VIP」新建的是 material 域行（与客户域「VIP」不同 id，互不影响）
    expect(tags.find((t) => t.name === "VIP")!.id).not.toBe(vip.json().data.id);

    // 词表核对：自建词 domain=material / scope=other / enabled=1
    const row = tmp.sqlite
      .prepare("SELECT domain, scope, enabled FROM tags WHERE id = ?")
      .get(tags.find((t) => t.name === "金句")!.id) as {
      domain: string;
      scope: string;
      enabled: number;
    };
    expect(row).toEqual({ domain: "material", scope: "other", enabled: 1 });
    // 两域同名共存
    const cnt = tmp.sqlite
      .prepare("SELECT COUNT(*) AS c FROM tags WHERE name = 'VIP' AND deleted_at IS NULL")
      .get() as { c: number };
    expect(cnt.c).toBe(2);
  });
});

describe("资料标签（K58）：PATCH 内核", () => {
  it("tagIds 缺席不动；[] 清空；[ids] 整表替换；customer 域 id → 422；newTagNames 单独出现在现有基础上追加", async () => {
    const { cookie } = await loginAsRole("admin");
    const t1 = await createMaterialTag(cookie, "标签甲");
    const t2 = await createMaterialTag(cookie, "标签乙");
    const customerTag = (await post("/api/v1/tags", cookie, { name: "客户词" })).json().data;
    const m = await createMaterial(cookie, { ...TEXT, tagIds: [t1.id] });

    // tagIds 缺席 → 不动
    clock.t += 1000;
    const r1 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      title: "只改标题",
      updatedAt: m.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.tags).toEqual([{ id: t1.id, name: "标签甲" }]);

    // newTagNames 单独出现 → 在现有标签基础上追加
    clock.t += 1000;
    const r2 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      newTagNames: ["标签丙"],
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.statusCode).toBe(200);
    expect((r2.json().data.tags as { name: string }[]).map((t) => t.name).sort()).toEqual(
      ["标签丙", "标签甲"].sort(),
    );

    // [ids] → 整表替换
    clock.t += 1000;
    const r3 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      tagIds: [t2.id],
      updatedAt: r2.json().data.updatedAt,
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.tags).toEqual([{ id: t2.id, name: "标签乙" }]);

    // customer 域 id → 422
    const bad = await patch(`/api/v1/materials/${m.id}`, cookie, {
      tagIds: [customerTag.id],
      updatedAt: r3.json().data.updatedAt,
    });
    expect(bad.statusCode).toBe(422);

    // [] → 清空
    clock.t += 1000;
    const r4 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      tagIds: [],
      updatedAt: r3.json().data.updatedAt,
    });
    expect(r4.statusCode).toBe(200);
    expect(r4.json().data.tags).toEqual([]);
  });

  it("OCC：旧 updatedAt → 409 且 data 带当前标签；已删 → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    const t1 = await createMaterialTag(cookie, "占用");
    const t2 = await createMaterialTag(cookie, "改后");
    const m = await createMaterial(cookie, { ...TEXT, tagIds: [t1.id] });

    clock.t += 1000;
    const r1 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      tagIds: [t2.id],
      updatedAt: m.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.tags).toEqual([{ id: t2.id, name: "改后" }]);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/materials/${m.id}`, cookie, {
      tagIds: [],
      updatedAt: m.updatedAt, // 过期
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    expect(r2.json().data.tags).toEqual([{ id: t2.id, name: "改后" }]);

    expect((await del(`/api/v1/materials/${m.id}`, cookie)).statusCode).toBe(204);
    expect(
      (
        await patch(`/api/v1/materials/${m.id}`, cookie, {
          tagIds: [t1.id],
          updatedAt: r1.json().data.updatedAt,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("资料标签（K58）：tagId 过滤与 q 命中标签名", () => {
  it("tagId 等值过滤；q ≥3 字符走 FTS 分支 OR、<3 字符走 LIKE 分支 OR；标签软删后不展开也不命中", async () => {
    const { cookie } = await loginAsRole("admin");
    const longTag = await createMaterialTag(cookie, "案例复盘"); // 4 字符 → FTS 分支
    const shortTag = await createMaterialTag(cookie, "金句"); // 2 字符 → LIKE 分支
    const m1 = await createMaterial(cookie, { ...TEXT, title: "无关标题甲", tagIds: [longTag.id] });
    const m2 = await createMaterial(cookie, { ...TEXT, title: "无关标题乙", tagIds: [shortTag.id] });
    await createMaterial(cookie, { ...TEXT, title: "无标签资料" });

    // tagId 等值过滤
    const byTag = await get(`/api/v1/materials?tagId=${longTag.id}`, cookie);
    expect(byTag.json().meta.total).toBe(1);
    expect(byTag.json().data[0].id).toBe(m1.id);

    // q ≥3 字符：标题/正文不含该词，仅标签名命中（FTS 分支 OR 标签命中）
    const qLong = await get(`/api/v1/materials?q=${encodeURIComponent("案例复盘")}`, cookie);
    expect(qLong.json().meta.total).toBe(1);
    expect(qLong.json().data[0].id).toBe(m1.id);

    // q <3 字符：LIKE 分支 OR 标签命中
    const qShort = await get(`/api/v1/materials?q=${encodeURIComponent("金句")}`, cookie);
    expect(qShort.json().meta.total).toBe(1);
    expect(qShort.json().data[0].id).toBe(m2.id);

    // 标签软删：不再展开，q 不再命中；tagId 过滤仍命中（软删不剥 join 行，同 customer_tags 语义 K9）
    expect((await del(`/api/v1/tags/${longTag.id}`, cookie)).statusCode).toBe(204);
    const detail = await get(`/api/v1/materials/${m1.id}`, cookie);
    expect(detail.json().data.tags).toEqual([]);
    expect(
      (await get(`/api/v1/materials?q=${encodeURIComponent("案例复盘")}`, cookie)).json().meta
        .total,
    ).toBe(0);
    expect((await get(`/api/v1/materials?tagId=${longTag.id}`, cookie)).json().meta.total).toBe(1);
  });
});
