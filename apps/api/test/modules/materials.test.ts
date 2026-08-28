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
  it("文本类 content 必填、媒体类 url 必填 → 422 VALIDATION；url 合法时 201", async () => {
    const { cookie } = await loginAsRole("admin");
    const noContent = await post("/api/v1/materials", cookie, { kind: "text", title: "无内容" });
    expect(noContent.statusCode).toBe(422);
    expect(noContent.json().error.code).toBe("VALIDATION");

    const noUrl = await post("/api/v1/materials", cookie, { kind: "video", title: "无链接" });
    expect(noUrl.statusCode).toBe(422);

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

  it("合并后重跑 kind↔content/url 组合校验：只改 kind 违反 → 422；补 url 后 → 200", async () => {
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

    // 文本类清空 content → 422
    clock.t += 1000;
    const clearContent = await patch(`/api/v1/materials/${m.id}`, cookie, {
      kind: "text",
      content: null,
      updatedAt: good.json().data.updatedAt,
    });
    expect(clearContent.statusCode).toBe(422);
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
