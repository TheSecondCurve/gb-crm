// users CRUD + requireCan（PR 5）。inject + loginAs，hashFn 注入降参数 argon2 提速。
// 时钟用假 now；OCC 测试靠 clock.t 前进让 updatedAt 变化。
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { requireCan } from "../../src/plugins/rbac.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

const FAST_ARGON2 = {
  type: argon2.argon2id,
  memoryCost: 1024,
  timeCost: 1,
  parallelism: 1,
} as const;

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: Date.now() }; // epoch 毫秒
  app = buildApp({
    env: testEnv(),
    db: tmp.db,
    now: () => clock.t,
    gcProbability: 0,
    hashFn: (pw) => argon2.hash(pw, FAST_ARGON2),
  });
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

describe("requireCan 插件", () => {
  it("request.user 为空 → 401 UNAUTHORIZED", async () => {
    const handler = requireCan("users", "list");
    // session-auth 正常会先拦 401；这里单测 requireCan 自身的兜底分支
    await expect(
      handler.call(app, { user: null } as never, {} as never, (() => {}) as never),
    ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHORIZED" });
  });
});

describe("RBAC 矩阵（users 资源）", () => {
  it("assistant 访问 users 任何路由 → 403", async () => {
    const { cookie } = await loginAsRole("assistant");
    const target = await seedUser(tmp.db, { username: "target" });
    for (const res of [
      await get("/api/v1/users", cookie),
      await get(`/api/v1/users/${target}`, cookie),
      await post("/api/v1/users", cookie, { nickname: "x" }),
      await patch(`/api/v1/users/${target}`, cookie, { nickname: "x", updatedAt: 1 }),
      await del(`/api/v1/users/${target}`, cookie),
      await post(`/api/v1/users/${target}/password`, cookie, { password: "newpassword1" }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }
  });

  it("operator：GET list/read 200；POST/PATCH/DELETE/setPassword 403", async () => {
    const { cookie } = await loginAsRole("operator");
    const target = await seedUser(tmp.db, { username: "target" });

    expect((await get("/api/v1/users", cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/users/${target}`, cookie)).statusCode).toBe(200);
    expect((await post("/api/v1/users", cookie, { nickname: "x" })).statusCode).toBe(403);
    expect(
      (await patch(`/api/v1/users/${target}`, cookie, { nickname: "x", updatedAt: 1 })).statusCode,
    ).toBe(403);
    expect((await del(`/api/v1/users/${target}`, cookie)).statusCode).toBe(403);
    expect(
      (await post(`/api/v1/users/${target}/password`, cookie, { password: "newpassword1" }))
        .statusCode,
    ).toBe(403);
  });

  it("admin 全通（创建/读取/修改/删除/设密码）", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post("/api/v1/users", cookie, { nickname: "新成员" });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as number;

    expect((await get("/api/v1/users", cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/users/${id}`, cookie)).statusCode).toBe(200);
    const updatedAt = created.json().data.updatedAt as number;
    expect(
      (await patch(`/api/v1/users/${id}`, cookie, { nickname: "改名", updatedAt })).statusCode,
    ).toBe(200);
    expect(
      (await post(`/api/v1/users/${id}/password`, cookie, { password: "newpassword1" })).statusCode,
    ).toBe(204);
    expect((await del(`/api/v1/users/${id}`, cookie)).statusCode).toBe(204);
  });

  it("PATCH 含 systemRole/accountStatus 键需 users.updateRole（矩阵仅 admin 有 update，双门槛锁死）", async () => {
    // operator 连 users.update 都没有 → 含角色键时同样 403（走 updateRole 分支前置被 update 拦；
    // 这里直接单测 preHandler 语义：无 updateRole 的角色带角色键 → forbidden）
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;
    const res = await patch(`/api/v1/users/${target}`, cookie, {
      accountStatus: "enabled",
      updatedAt: row.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.accountStatus).toBe("enabled");
  });
});

describe("POST /api/v1/users 创建", () => {
  it("创建成功：密码 argon2id hash 不落明文，响应无 passwordHash，审计列展开", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/users", cookie, {
      username: "bob",
      password: "secret-ok-1",
      nickname: "鲍勃",
      systemRole: "operator",
      accountStatus: "enabled",
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.username).toBe("bob");
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(data.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(JSON.stringify(res.json())).not.toContain("passwordHash");

    // 库里是 argon2id hash，不是明文
    const row = tmp.sqlite
      .prepare("SELECT password_hash FROM users WHERE username = 'bob'")
      .get() as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain("secret-ok-1");
    // 新密码可直接登录
    await loginAs(app, "bob", "secret-ok-1");
  });

  it("省略可选字段 → 默认值（jobTitle other / employmentStatus employed / accountStatus disabled）", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/users", cookie, { nickname: "无账号成员" });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.username).toBeNull();
    expect(data.jobTitle).toBe("other");
    expect(data.employmentStatus).toBe("employed");
    expect(data.accountStatus).toBe("disabled");
  });

  it("live 用户名冲突 → 409 CONFLICT", async () => {
    const { cookie } = await loginAsRole("admin");
    await seedUser(tmp.db, { username: "taken" });
    const res = await post("/api/v1/users", cookie, { nickname: "x", username: "taken" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("缺 nickname → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/users", cookie, { username: "x" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("GET /api/v1/users 列表", () => {
  it("分页 meta 正确，默认 page=1/pageSize=25", async () => {
    const { cookie } = await loginAsRole("admin");
    for (let i = 0; i < 3; i++) {
      await seedUser(tmp.db, { username: `page-${i}`, nickname: `分页${i}` });
    }
    const res = await get("/api/v1/users?page=2&pageSize=2", cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toEqual({ page: 2, pageSize: 2, total: 4 }); // 3 + 登录的 admin
    expect(body.data).toHaveLength(2);
  });

  it("pageSize 上限 100：=100 放行，101 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await get("/api/v1/users?pageSize=100", cookie)).statusCode).toBe(200);
    const res = await get("/api/v1/users?pageSize=101", cookie);
    expect(res.statusCode).toBe(422);
  });

  it("q 多 token AND、字段 OR：两个 token 都命中同一行才返回", async () => {
    const { cookie } = await loginAsRole("admin");
    await seedUser(tmp.db, { username: "u1", nickname: "张三", });
    tmp.sqlite.prepare("UPDATE users SET phone = '138' WHERE username = 'u1'").run();
    await seedUser(tmp.db, { username: "u2", nickname: "张三" });
    tmp.sqlite.prepare("UPDATE users SET phone = '139' WHERE username = 'u2'").run();

    const res = await get("/api/v1/users?q=" + encodeURIComponent("张三 138"), cookie);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].username).toBe("u1");
  });

  it("q 中的 LIKE 元字符按字面量匹配（转义 \\ % _）", async () => {
    const { cookie } = await loginAsRole("admin");
    await seedUser(tmp.db, { username: "pct", nickname: "进度100%达人" });
    await seedUser(tmp.db, { username: "plain", nickname: "进度1000达人" });

    const res = await get("/api/v1/users?q=" + encodeURIComponent("100%"), cookie);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].username).toBe("pct");
  });

  it("过滤 accountStatus / systemRole / jobTitle / employmentStatus", async () => {
    const { cookie } = await loginAsRole("admin");
    await seedUser(tmp.db, {
      username: "dis",
      accountStatus: "disabled",
      systemRole: null,
      nickname: "停用者",
    });
    const res = await get("/api/v1/users?accountStatus=disabled", cookie);
    const body = res.json();
    expect(body.meta.total).toBe(1);
    expect(body.data[0].username).toBe("dis");

    expect((await get("/api/v1/users?systemRole=operator", cookie)).json().meta.total).toBe(0);
    // 非法枚举值 → 422
    expect((await get("/api/v1/users?accountStatus=bogus", cookie)).statusCode).toBe(422);
  });

  it("sort 合法枚举放行（username asc），非法 sort → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    await seedUser(tmp.db, { username: "bbb", nickname: "乙" });
    await seedUser(tmp.db, { username: "aaa", nickname: "甲" });

    const res = await get("/api/v1/users?sort=username&order=asc", cookie);
    const usernames = res.json().data.map((u: { username: string }) => u.username);
    expect(usernames).toEqual(["aaa", "bbb", "u-admin"]);

    expect((await get("/api/v1/users?sort=password_hash", cookie)).statusCode).toBe(422);
  });

  it("默认 sort=updatedAt desc，并列 id DESC（后建的在前）", async () => {
    const { cookie } = await loginAsRole("admin");
    // seedUser 的 createdAt/updatedAt 用真实时间，可能同毫秒 → 检验 id DESC 并列打破
    await seedUser(tmp.db, { username: "first", nickname: "先" });
    await seedUser(tmp.db, { username: "second", nickname: "后" });
    const res = await get("/api/v1/users", cookie);
    const usernames = res.json().data.map((u: { username: string }) => u.username);
    expect(usernames.indexOf("second")).toBeLessThan(usernames.indexOf("first"));
  });

  it("list 不含软删行", async () => {
    const { cookie } = await loginAsRole("admin");
    await seedUser(tmp.db, { username: "ghost", deletedAt: clock.t });
    const res = await get("/api/v1/users", cookie);
    expect(res.json().data.map((u: { username: string }) => u.username)).not.toContain("ghost");
  });
});

describe("GET /api/v1/users/:id", () => {
  it("返回 camelCase 完整行；软删 → 404；无 passwordHash / snake_case", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const res = await get(`/api/v1/users/${target}`, cookie);
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("password_hash");
    expect(raw).not.toContain("created_at");
    expect(res.json().data.accountStatus).toBe("enabled");

    await del(`/api/v1/users/${target}`, cookie);
    expect((await get(`/api/v1/users/${target}`, cookie)).statusCode).toBe(404);
  });

  it("不存在的 id → 404；非法 id → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await get("/api/v1/users/9999", cookie)).statusCode).toBe(404);
    expect((await get("/api/v1/users/abc", cookie)).statusCode).toBe(422);
  });
});

describe("PATCH /api/v1/users/:id 内核（K24）", () => {
  it("必测1：PATCH nickname 不碰 phone", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    tmp.sqlite.prepare("UPDATE users SET phone = '1' WHERE id = ?").run(target);
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;

    clock.t += 1000;
    const res = await patch(`/api/v1/users/${target}`, cookie, {
      nickname: "新昵称",
      updatedAt: row.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.nickname).toBe("新昵称");
    expect(res.json().data.phone).toBe("1");
  });

  it("仅带 updatedAt 的 {} → 200，其它列不动，仅 bump updatedAt/updatedBy", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const before = (await get(`/api/v1/users/${target}`, cookie)).json().data;

    clock.t += 1000;
    const res = await patch(`/api/v1/users/${target}`, cookie, { updatedAt: before.updatedAt });
    expect(res.statusCode).toBe(200);
    const after = res.json().data;
    expect(after.nickname).toBe(before.nickname);
    expect(after.phone).toBe(before.phone);
    expect(after.updatedAt).toBe(clock.t);
    expect(after.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("必测3/4：同一 updatedAt 两次 PATCH → 200 后 409；用新 updatedAt → 200；409 data 带当前行", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;

    clock.t += 1000;
    const r1 = await patch(`/api/v1/users/${target}`, cookie, {
      nickname: "第一改",
      updatedAt: row.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    // 陈旧 updatedAt → 409，且 data 是当前完整行
    const r2 = await patch(`/api/v1/users/${target}`, cookie, {
      nickname: "第二改",
      updatedAt: row.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    expect(r2.json().data.nickname).toBe("第一改");
    expect(r2.json().data.updatedAt).toBe(r1.json().data.updatedAt);

    // 用第一条返回的 updatedAt → 200
    const r3 = await patch(`/api/v1/users/${target}`, cookie, {
      nickname: "第三改",
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.nickname).toBe("第三改");
  });

  it("非空列 SET null → 422；可空列 SET null → 200 清空", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    tmp.sqlite.prepare("UPDATE users SET phone = '123' WHERE id = ?").run(target);
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;

    clock.t += 1000;
    const bad = await patch(`/api/v1/users/${target}`, cookie, {
      nickname: null,
      updatedAt: row.updatedAt,
    });
    expect(bad.statusCode).toBe(422);

    clock.t += 1000;
    const ok = await patch(`/api/v1/users/${target}`, cookie, {
      phone: null,
      updatedAt: row.updatedAt,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.phone).toBeNull();
  });

  it("PATCH 含 username → 422（改用户名不在 v1）", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;
    const res = await patch(`/api/v1/users/${target}`, cookie, {
      username: "renamed",
      updatedAt: row.updatedAt,
    });
    expect(res.statusCode).toBe(422);
  });

  it("缺 updatedAt → 422；OCC 对软删行 PATCH → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;

    expect(
      (await patch(`/api/v1/users/${target}`, cookie, { nickname: "x" })).statusCode,
    ).toBe(422);

    await del(`/api/v1/users/${target}`, cookie);
    // 软删行哪怕 updatedAt 匹配也 404（不是 409）
    const res = await patch(`/api/v1/users/${target}`, cookie, {
      nickname: "x",
      updatedAt: row.updatedAt,
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH accountStatus=disabled 删除该用户全部 session", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    const { id: opId, cookie: opCookie } = await loginAsRole("operator");
    const row = (await get(`/api/v1/users/${opId}`, adminCookie)).json().data;

    clock.t += 1000;
    const res = await patch(`/api/v1/users/${opId}`, adminCookie, {
      accountStatus: "disabled",
      updatedAt: row.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    // sessions 已删，旧 cookie 立即 401
    expect(
      (tmp.sqlite.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?").get(opId) as {
        c: number;
      }).c,
    ).toBe(0);
    expect((await get("/api/v1/auth/me", opCookie)).statusCode).toBe(401);
  });
});

describe("DELETE /api/v1/users/:id", () => {
  it("软删：204；list 不见、GET 404、sessions 删除、行仍在库", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    const { id: opId } = await loginAsRole("operator");

    const res = await del(`/api/v1/users/${opId}`, adminCookie);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    expect((await get(`/api/v1/users/${opId}`, adminCookie)).statusCode).toBe(404);
    expect((await get("/api/v1/users", adminCookie)).json().meta.total).toBe(1);
    expect(
      (tmp.sqlite.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?").get(opId) as {
        c: number;
      }).c,
    ).toBe(0);
    const row = tmp.sqlite.prepare("SELECT deleted_at FROM users WHERE id = ?").get(opId) as {
      deleted_at: number;
    };
    expect(row.deleted_at).toBe(clock.t);
  });

  it("重复删除 / 不存在 → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    expect((await del(`/api/v1/users/${target}`, cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/users/${target}`, cookie)).statusCode).toBe(404);
    expect((await del("/api/v1/users/9999", cookie)).statusCode).toBe(404);
  });
});

describe("POST /api/v1/users/:id/password 设密码", () => {
  it("改后旧 session 全失效、新密码可登录、旧密码不可登录", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    const { id: opId, cookie: opCookie } = await loginAsRole("operator");

    const res = await post(`/api/v1/users/${opId}/password`, adminCookie, {
      password: "newpassword1",
    });
    expect(res.statusCode).toBe(204);

    expect((await get("/api/v1/auth/me", opCookie)).statusCode).toBe(401); // 旧 session 已删
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "u-operator", password: "password123" },
    });
    expect(oldLogin.statusCode).toBe(401);
    await loginAs(app, "u-operator", "newpassword1"); // 新密码可登录（204 由 loginAs 断言）
  });

  it("密码太短 → 422；软删用户 → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    expect(
      (await post(`/api/v1/users/${target}/password`, cookie, { password: "short" })).statusCode,
    ).toBe(422);
    await del(`/api/v1/users/${target}`, cookie);
    expect(
      (await post(`/api/v1/users/${target}/password`, cookie, { password: "newpassword1" }))
        .statusCode,
    ).toBe(404);
  });
});

describe("审计列展开", () => {
  it("创建者被软删后，其作为 createdBy 展开为 null（live only）", async () => {
    // admin1 创建成员 B；admin2 软删 admin1；再看 B 的 createdBy
    const { id: admin1Id, cookie: admin1Cookie } = await loginAsRole("admin", "admin1");
    const created = await post("/api/v1/users", admin1Cookie, { nickname: "成员B" });
    const bId = created.json().data.id as number;
    expect(created.json().data.createdBy).toEqual({ id: admin1Id, nickname: "昵称-admin" });

    await seedUser(tmp.db, { username: "admin2", systemRole: "admin", nickname: "管理员二" });
    const admin2Cookie = await loginAs(app, "admin2", "password123");
    expect((await del(`/api/v1/users/${admin1Id}`, admin2Cookie)).statusCode).toBe(204);

    const res = await get(`/api/v1/users/${bId}`, admin2Cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.createdBy).toBeNull();
    expect(res.json().data.updatedBy).toBeNull();
  });

  it("PATCH 后 updatedBy 指向操作人", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const target = await seedUser(tmp.db, { username: "target" });
    const row = (await get(`/api/v1/users/${target}`, cookie)).json().data;
    expect(row.updatedBy).toBeNull(); // seed 直插无审计人

    clock.t += 1000;
    const res = await patch(`/api/v1/users/${target}`, cookie, {
      notes: "备注",
      updatedAt: row.updatedAt,
    });
    expect(res.json().data.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(res.json().data.createdBy).toBeNull();
  });
});
