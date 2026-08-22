// products CRUD + priceCents（K13）+ RBAC（PR 6）。inject + loginAs，假时钟控 updatedAt。
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

/** 以 admin 建一个产品（含 notes 与 priceCents），返回响应 data */
async function createProductAsAdmin(extra: JsonBody = {}) {
  const { id: adminId, cookie } = await loginAsRole("admin");
  const res = await post("/api/v1/products", cookie, {
    name: "咨询产品",
    notes: "备注甲",
    priceCents: 19900,
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return { adminId, cookie, data: res.json().data };
}

describe("RBAC 矩阵（products 资源）", () => {
  it("assistant：list/read → 200；create/update/delete → 403", async () => {
    const { cookie } = await loginAsRole("assistant");
    const { data: p } = await createProductAsAdmin();

    expect((await get("/api/v1/products", cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/products/${p.id}`, cookie)).statusCode).toBe(200);
    expect((await post("/api/v1/products", cookie, { name: "x" })).statusCode).toBe(403);
    expect(
      (await patch(`/api/v1/products/${p.id}`, cookie, { name: "x", updatedAt: p.updatedAt }))
        .statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/products/${p.id}`, cookie)).statusCode).toBe(403);
    expect((await patch(`/api/v1/products/${p.id}`, cookie, { name: "x", updatedAt: 1 })).json().error.code).toBe("FORBIDDEN");
  });

  it("operator/admin 全通（create/read/update/delete）", async () => {
    const { cookie: opCookie } = await loginAsRole("operator");
    const created = await post("/api/v1/products", opCookie, { name: "运营建的" });
    expect(created.statusCode).toBe(201);
    const p = created.json().data;

    clock.t += 1000;
    const updated = await patch(`/api/v1/products/${p.id}`, opCookie, {
      status: "off_sale",
      updatedAt: p.updatedAt,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.status).toBe("off_sale");
    expect((await del(`/api/v1/products/${p.id}`, opCookie)).statusCode).toBe(204);
  });
});

describe("POST /api/v1/products 创建", () => {
  it("省略可选字段 → 默认值（productType c_consulting / status on_sale / isPackage false / priceCents null）；审计列展开", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/products", cookie, { name: "极简产品" });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.productType).toBe("c_consulting");
    expect(data.status).toBe("on_sale");
    expect(data.isPackage).toBe(false);
    expect(data.priceCents).toBeNull();
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });

    // 库里 isPackage 存 0/1
    const row = tmp.sqlite
      .prepare("SELECT is_package FROM products WHERE id = ?")
      .get(data.id) as { is_package: number };
    expect(row.is_package).toBe(0);
  });

  it("isPackage=true 写入库为 1，读出为 boolean true", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/products", cookie, { name: "套餐", isPackage: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.isPackage).toBe(true);
    const row = tmp.sqlite
      .prepare("SELECT is_package FROM products WHERE id = ?")
      .get(res.json().data.id) as { is_package: number };
    expect(row.is_package).toBe(1);
  });

  it("缺 name / 非整数 priceCents → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/products", cookie, {})).statusCode).toBe(422);
    expect(
      (await post("/api/v1/products", cookie, { name: "x", priceCents: 19.9 })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/products", cookie, { name: "x", priceCents: "199" })).statusCode,
    ).toBe(422);
  });
});

describe("priceCents（K13）", () => {
  it("正常读写；PATCH null → SET NULL 清空", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    expect(p.priceCents).toBe(19900);

    clock.t += 1000;
    const r1 = await patch(`/api/v1/products/${p.id}`, cookie, {
      priceCents: 29900,
      updatedAt: p.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.priceCents).toBe(29900);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/products/${p.id}`, cookie, {
      priceCents: null,
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data.priceCents).toBeNull();
    const row = tmp.sqlite
      .prepare("SELECT price_cents FROM products WHERE id = ?")
      .get(p.id) as { price_cents: number | null };
    expect(row.price_cents).toBeNull();
  });

  it("PATCH 非整数 priceCents → 422", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    const res = await patch(`/api/v1/products/${p.id}`, cookie, {
      priceCents: 99.5,
      updatedAt: p.updatedAt,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("GET /api/v1/products 列表", () => {
  it("分页 meta 正确；list 不含软删行；无 snake_case 泄漏", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    await post("/api/v1/products", cookie, { name: "产品二" });

    const res = await get("/api/v1/products?page=1&pageSize=1", cookie);
    expect(res.json().meta).toEqual({ page: 1, pageSize: 1, total: 2 });
    expect(res.json().data).toHaveLength(1);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("price_cents");
    expect(raw).not.toContain("is_package");
    expect(raw).not.toContain("created_at");

    await del(`/api/v1/products/${p.id}`, cookie);
    expect((await get("/api/v1/products", cookie)).json().meta.total).toBe(1);
  });

  it("q 搜索 name/notes", async () => {
    const { cookie } = await createProductAsAdmin();
    await post("/api/v1/products", cookie, { name: "圈子订阅", notes: "年费" });

    const byNotes = await get("/api/v1/products?q=" + encodeURIComponent("备注甲"), cookie);
    expect(byNotes.json().data.map((x: { name: string }) => x.name)).toEqual(["咨询产品"]);
    const byName = await get("/api/v1/products?q=" + encodeURIComponent("圈子"), cookie);
    expect(byName.json().meta.total).toBe(1);
    const none = await get("/api/v1/products?q=" + encodeURIComponent("圈子 备注甲"), cookie);
    expect(none.json().meta.total).toBe(0);
  });

  it("过滤 productType/status/isPackage；isPackage 只收 true/false", async () => {
    const { cookie } = await createProductAsAdmin({ productType: "knowledge", isPackage: true });
    await post("/api/v1/products", cookie, { name: "普通产品", status: "in_dev" });

    const pkg = await get("/api/v1/products?isPackage=true", cookie);
    expect(pkg.json().meta.total).toBe(1);
    expect(pkg.json().data[0].name).toBe("咨询产品");
    const notPkg = await get("/api/v1/products?isPackage=false", cookie);
    expect(notPkg.json().meta.total).toBe(1);
    expect(notPkg.json().data[0].name).toBe("普通产品");

    expect((await get("/api/v1/products?productType=knowledge", cookie)).json().meta.total).toBe(1);
    expect((await get("/api/v1/products?status=in_dev", cookie)).json().meta.total).toBe(1);
    expect((await get("/api/v1/products?isPackage=1", cookie)).statusCode).toBe(422);
    expect((await get("/api/v1/products?status=bogus", cookie)).statusCode).toBe(422);
  });

  it("sort=priceCents 放行（asc/desc）；非法 sort → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/products", cookie, { name: "贵", priceCents: 30000 });
    await post("/api/v1/products", cookie, { name: "便宜", priceCents: 100 });
    await post("/api/v1/products", cookie, { name: "未定价" });

    const asc = await get("/api/v1/products?sort=priceCents&order=asc", cookie);
    const priced = asc
      .json()
      .data.filter((x: { priceCents: number | null }) => x.priceCents !== null)
      .map((x: { priceCents: number }) => x.priceCents);
    expect(priced).toEqual([100, 30000]);

    const descRes = await get("/api/v1/products?sort=priceCents&order=desc", cookie);
    expect(descRes.json().data[0].name).toBe("贵");

    expect((await get("/api/v1/products?sort=deletedAt", cookie)).statusCode).toBe(422);
  });
});

describe("PATCH /api/v1/products/:id 内核（K24）", () => {
  it("必测1：PATCH name 不碰 notes", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    clock.t += 1000;
    const res = await patch(`/api/v1/products/${p.id}`, cookie, {
      name: "改名",
      updatedAt: p.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("改名");
    expect(res.json().data.notes).toBe("备注甲");
  });

  it("仅带 updatedAt 的 {} → 200，仅 bump updatedAt/updatedBy", async () => {
    const { adminId, cookie, data: p } = await createProductAsAdmin();
    clock.t += 1000;
    const res = await patch(`/api/v1/products/${p.id}`, cookie, { updatedAt: p.updatedAt });
    expect(res.statusCode).toBe(200);
    const after = res.json().data;
    expect(after.name).toBe("咨询产品");
    expect(after.updatedAt).toBe(clock.t);
    expect(after.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("必测3/4：同一 updatedAt 两次 PATCH → 200 后 409；用新 updatedAt → 200；409 data 带当前行", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    clock.t += 1000;
    const r1 = await patch(`/api/v1/products/${p.id}`, cookie, {
      name: "第一改",
      updatedAt: p.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/products/${p.id}`, cookie, {
      name: "第二改",
      updatedAt: p.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    expect(r2.json().data.name).toBe("第一改");
    expect(r2.json().data.updatedAt).toBe(r1.json().data.updatedAt);

    const r3 = await patch(`/api/v1/products/${p.id}`, cookie, {
      name: "第三改",
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.name).toBe("第三改");
  });

  it("非空列 name SET null → 422；可空列 notes SET null → 200 清空；isPackage 可 PATCH 切换", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    expect(
      (await patch(`/api/v1/products/${p.id}`, cookie, { name: null, updatedAt: p.updatedAt }))
        .statusCode,
    ).toBe(422);

    clock.t += 1000;
    const ok = await patch(`/api/v1/products/${p.id}`, cookie, {
      notes: null,
      isPackage: true,
      updatedAt: p.updatedAt,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.notes).toBeNull();
    expect(ok.json().data.isPackage).toBe(true);
  });

  it("缺 updatedAt → 422；软删行 PATCH → 404（不是 409）", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    expect((await patch(`/api/v1/products/${p.id}`, cookie, { name: "x" })).statusCode).toBe(422);

    await del(`/api/v1/products/${p.id}`, cookie);
    const res = await patch(`/api/v1/products/${p.id}`, cookie, {
      name: "x",
      updatedAt: p.updatedAt,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("defaultTasks（K43 交付动作模板）", () => {
  it("创建写入多行文本；PATCH null → 清空；缺省 → null", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/products", cookie, {
      name: "圈子产品",
      defaultTasks: "拉群\n商品发货\n开课提醒",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.defaultTasks).toBe("拉群\n商品发货\n开课提醒");

    const p = created.json().data;
    clock.t += 1000;
    const cleared = await patch(`/api/v1/products/${p.id}`, cookie, {
      defaultTasks: null,
      updatedAt: p.updatedAt,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.defaultTasks).toBeNull();

    const minimal = await post("/api/v1/products", cookie, { name: "无模板产品" });
    expect(minimal.json().data.defaultTasks).toBeNull();
  });
});

describe("GET /api/v1/products/:id 与 DELETE", () => {
  it("GET：软删/不存在 → 404；非法 id → 422。DELETE：204；重复删除 → 404", async () => {
    const { cookie, data: p } = await createProductAsAdmin();
    expect((await get("/api/v1/products/9999", cookie)).statusCode).toBe(404);
    expect((await get("/api/v1/products/abc", cookie)).statusCode).toBe(422);

    expect((await del(`/api/v1/products/${p.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/products/${p.id}`, cookie)).statusCode).toBe(404);
    expect((await del(`/api/v1/products/${p.id}`, cookie)).statusCode).toBe(404);
    const row = tmp.sqlite
      .prepare("SELECT deleted_at FROM products WHERE id = ?")
      .get(p.id) as { deleted_at: number };
    expect(row.deleted_at).toBe(clock.t);
  });
});
