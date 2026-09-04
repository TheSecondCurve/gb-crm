// tags 词表 CRUD + RBAC（K45）+ name live-unique + OCC + 软删释放名字。
// inject + loginAs，假时钟控 updatedAt；迁移种子含 13 个核心标签。
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

describe("RBAC（tags 资源，K45）", () => {
  it("assistant/operator：GET 200；POST/PATCH/DELETE → 403", async () => {
    for (const role of ["assistant", "operator"] as const) {
      const { cookie } = await loginAsRole(role);
      expect((await get("/api/v1/tags", cookie)).statusCode).toBe(200);
      expect((await post("/api/v1/tags", cookie, { name: "x" })).statusCode).toBe(403);
    }
    const { id: adminId, cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/tags", cookie, { name: "待删" });
    expect(created.statusCode).toBe(201);
    const tag = created.json().data;

    const asst = await loginAsRole("assistant", "u-asst2");
    expect((await patch(`/api/v1/tags/${tag.id}`, asst.cookie, { name: "y", updatedAt: tag.updatedAt })).statusCode).toBe(403);
    expect((await del(`/api/v1/tags/${tag.id}`, asst.cookie)).statusCode).toBe(403);

    // 防未使用告警：adminId 保留在作用域
    void adminId;
  });

  it("未登录 → 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/tags" })).statusCode).toBe(401);
  });
});

describe("GET /api/v1/tags 列表", () => {
  it("迁移种子 13 个核心标签在库；默认 sort=name&order=asc", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await get("/api/v1/tags?pageSize=100", cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { name: string }[];
    expect(data.length).toBe(13);
    const names = data.map((t) => t.name);
    expect(names).toContain("创业者");
    expect(names).toContain("已成交");
    expect(names).toContain("商学院");
    // 默认 name 按字节序 asc（SQLite 排序；BMP 中文 = code point 序）
    expect(names).toEqual([...names].sort());
  });

  it("scope 过滤；q 搜 name；camelCase 无 snake_case 泄漏", async () => {
    const { cookie } = await loginAsRole("admin");
    const byScope = await get("/api/v1/tags?scope=stage&pageSize=100", cookie);
    expect(byScope.json().meta.total).toBe(5);
    for (const t of byScope.json().data) expect(t.scope).toBe("stage");

    const q = await get(`/api/v1/tags?q=${encodeURIComponent("创业者")}`, cookie);
    expect(q.json().meta.total).toBe(1);

    const raw = JSON.stringify(byScope.json());
    expect(raw).not.toContain("deleted_at");
    expect(raw).not.toContain("created_at");
  });
});

describe("POST /api/v1/tags 创建", () => {
  it("默认值：scope=other、sort=0、enabled=true；审计列展开", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/tags", cookie, { name: "高意向" });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.name).toBe("高意向");
    expect(data.scope).toBe("other");
    expect(data.sort).toBe(0);
    expect(data.enabled).toBe(true);
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("name 必填/空 → 422；scope 非法 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/tags", cookie, {})).statusCode).toBe(422);
    expect((await post("/api/v1/tags", cookie, { name: "" })).statusCode).toBe(422);
    expect((await post("/api/v1/tags", cookie, { name: "x", scope: "bogus" })).statusCode).toBe(422);
  });

  it("name 与 live 行冲突 → 409（种子已有「创业者」）", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/tags", cookie, { name: "创业者" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });
});

describe("PATCH /api/v1/tags/:id 内核（K24）", () => {
  it("改 scope/sort/enabled；enabled API boolean ↔ 库 0/1", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/tags", cookie, { name: "待改", scope: "interest" });
    const tag = created.json().data;

    clock.t += 1000;
    const res = await patch(`/api/v1/tags/${tag.id}`, cookie, {
      scope: "stage",
      sort: 9,
      enabled: false,
      updatedAt: tag.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.scope).toBe("stage");
    expect(res.json().data.sort).toBe(9);
    expect(res.json().data.enabled).toBe(false);
    const row = tmp.sqlite.prepare("SELECT enabled FROM tags WHERE id = ?").get(tag.id) as {
      enabled: number;
    };
    expect(row.enabled).toBe(0);
  });

  it("改名与他人 live 冲突 → 409；自身同值不算冲突", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/tags", cookie, { name: "甲方" });
    const created = await post("/api/v1/tags", cookie, { name: "乙方" });
    const tag = created.json().data;

    clock.t += 1000;
    const conflict = await patch(`/api/v1/tags/${tag.id}`, cookie, {
      name: "甲方",
      updatedAt: tag.updatedAt,
    });
    expect(conflict.statusCode).toBe(409);

    clock.t += 1000;
    const self = await patch(`/api/v1/tags/${tag.id}`, cookie, {
      name: "乙方",
      updatedAt: tag.updatedAt, // 冲突 PATCH 未写入，updatedAt 未变
    });
    expect(self.statusCode).toBe(200);
  });

  it("同一 updatedAt 两次 PATCH → 200 后 409，409 data 带当前行", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/tags", cookie, { name: "OCC" });
    const tag = created.json().data;

    clock.t += 1000;
    const r1 = await patch(`/api/v1/tags/${tag.id}`, cookie, { sort: 1, updatedAt: tag.updatedAt });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/tags/${tag.id}`, cookie, { sort: 2, updatedAt: tag.updatedAt });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().data.sort).toBe(1);
    expect(r2.json().data.updatedAt).toBe(r1.json().data.updatedAt);
  });

  it("软删行 PATCH → 404；缺 updatedAt → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/tags", cookie, { name: "幽灵" });
    const tag = created.json().data;

    await del(`/api/v1/tags/${tag.id}`, cookie);
    expect(
      (await patch(`/api/v1/tags/${tag.id}`, cookie, { name: "x", updatedAt: tag.updatedAt }))
        .statusCode,
    ).toBe(404);

    expect((await patch(`/api/v1/tags/${tag.id}`, cookie, { name: "x" })).statusCode).toBe(422);
  });
});

describe("DELETE /api/v1/tags/:id 软删", () => {
  it("204；重复删除 404；软删后 name 可复用（live-unique 释放）", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/tags", cookie, { name: "一次性标签" });
    const tag = created.json().data;

    expect((await del(`/api/v1/tags/${tag.id}`, cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/tags/${tag.id}`, cookie)).statusCode).toBe(404);

    const row = tmp.sqlite
      .prepare("SELECT deleted_at, name FROM tags WHERE id = ?")
      .get(tag.id) as { deleted_at: number; name: string };
    expect(row.deleted_at).toBe(clock.t);

    const reuse = await post("/api/v1/tags", cookie, { name: "一次性标签" });
    expect(reuse.statusCode).toBe(201);
    expect(reuse.json().data.id).not.toBe(tag.id);
  });
});

describe("K58 domain 域隔离", () => {
  it("list 缺省只回 customer 域；?domain=material 回资料域", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/tags", cookie, { name: "资料词A", domain: "material" });
    await post("/api/v1/tags", cookie, { name: "客户词A" });

    const def = await get("/api/v1/tags?pageSize=100", cookie);
    expect(def.json().meta.total).toBe(14); // 13 种子（customer）+ 客户词A
    const names = (def.json().data as { name: string; domain: string }[]).map((t) => t.name);
    expect(names).toContain("客户词A");
    expect(names).not.toContain("资料词A");
    for (const t of def.json().data) expect(t.domain).toBe("customer");

    const mat = await get("/api/v1/tags?domain=material&pageSize=100", cookie);
    expect(mat.json().meta.total).toBe(1);
    expect(mat.json().data[0].name).toBe("资料词A");
    expect(mat.json().data[0].domain).toBe("material");
  });

  it("创建 domain=material 成功；缺省 domain=customer；两域可同名；同域同名 → 409", async () => {
    const { cookie } = await loginAsRole("admin");
    const m1 = await post("/api/v1/tags", cookie, { name: "双域词", domain: "material" });
    expect(m1.statusCode).toBe(201);
    expect(m1.json().data.domain).toBe("material");

    const c1 = await post("/api/v1/tags", cookie, { name: "双域词" });
    expect(c1.statusCode).toBe(201); // 异域同名不冲突
    expect(c1.json().data.domain).toBe("customer");

    expect((await post("/api/v1/tags", cookie, { name: "双域词" })).statusCode).toBe(409);
    expect(
      (await post("/api/v1/tags", cookie, { name: "双域词", domain: "material" })).statusCode,
    ).toBe(409);
  });

  it("PATCH 改名：同域冲突 → 409；异域同名 → 200；PATCH 带 domain 键被 zod strip 不改域", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/tags", cookie, { name: "资料甲", domain: "material" });
    const matB = (await post("/api/v1/tags", cookie, { name: "资料乙", domain: "material" })).json()
      .data;
    await post("/api/v1/tags", cookie, { name: "客户丙" }); // customer 域

    // 同域冲突 → 409
    clock.t += 1000;
    expect(
      (
        await patch(`/api/v1/tags/${matB.id}`, cookie, {
          name: "资料甲",
          updatedAt: matB.updatedAt,
        })
      ).statusCode,
    ).toBe(409);

    // 改成与客户域同名 → 200；携带的 domain 键被 strip，域不变
    clock.t += 1000;
    const ok = await patch(`/api/v1/tags/${matB.id}`, cookie, {
      name: "客户丙",
      domain: "customer",
      updatedAt: matB.updatedAt, // 409 未写入，updatedAt 未变
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.name).toBe("客户丙");
    expect(ok.json().data.domain).toBe("material");
  });
});
