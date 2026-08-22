import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/modules/auth/service.js";
import { loginAs, seedUser, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

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

const login = (username: string, password: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username, password }, headers });

describe("POST /api/v1/auth/login", () => {
  it("成功 → 204 + 签名 Set-Cookie（HttpOnly/Path=/ /SameSite=Lax/Max-Age=12h）", async () => {
    await seedUser(tmp.db);
    const res = await login("alice", "password123");
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const setCookie = res.headers["set-cookie"] as string;
    // 签名格式：<hex id>.<base64 signature>
    expect(setCookie).toMatch(/^gb_crm_sid=[0-9a-f]{64}\.[A-Za-z0-9+/]+/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=43200");
    expect(setCookie).not.toContain("Secure");

    // sessions 行已创建
    const rows = tmp.sqlite.prepare("SELECT * FROM sessions").all() as {
      id: string;
      expires_at: number;
      created_at: number;
      last_touched_at: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.created_at).toBe(clock.t);
    expect(rows[0]!.expires_at).toBe(clock.t + 12 * 3600 * 1000); // idle 12h，epoch ms
    expect(rows[0]!.last_touched_at).toBe(clock.t);
  });

  it("COOKIE_SECURE=true 时带 Secure", async () => {
    await seedUser(tmp.db);
    const secureApp = buildApp({
      env: testEnv({ COOKIE_SECURE: "true" }),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
    });
    try {
      const res = await secureApp.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "alice", password: "password123" },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers["set-cookie"] as string).toContain("Secure");
    } finally {
      await secureApp.close();
    }
  });

  it.each([
    ["无 systemRole", { systemRole: null }],
    ["accountStatus=disabled", { accountStatus: "disabled" }],
    ["password_hash 为空", { password: null }],
    ["已软删", { deletedAt: 1 }],
  ])("四项闸门：%s → 401 INVALID_CREDENTIALS 统一消息", async (_label, opts) => {
    await seedUser(tmp.db, opts);
    const res = await login("alice", "password123");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({
      error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" },
    });
  });

  it("密码错误 → 401 统一消息", async () => {
    await seedUser(tmp.db);
    const res = await login("alice", "wrong-password");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "用户名或密码错误",
    });
  });

  it("用户不存在 → 401 统一消息（dummy hash 不暴露用户是否存在）", async () => {
    const res = await login("nobody", "password123");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("用户名或密码错误");
  });

  it("body 不合法 → 422 VALIDATION", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
    expect(res.json().error.details).toBeDefined();
  });
});

describe("GET /api/v1/auth/me", () => {
  it("带 cookie → 200 { id, username, nickname, systemRole, impersonatedBy: null }，无 passwordHash", async () => {
    const id = await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: { id, username: "alice", nickname: "爱丽丝", systemRole: "admin", impersonatedBy: null },
    });
    expect(JSON.stringify(res.json())).not.toContain("passwordHash");
  });

  it("无 cookie → 401 UNAUTHORIZED", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("未签名的 raw session id → 401", async () => {
    await seedUser(tmp.db);
    await loginAs(app, "alice", "password123");
    const rawId = (tmp.sqlite.prepare("SELECT id FROM sessions").get() as { id: string }).id;
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `gb_crm_sid=${rawId}` }, // 未签名
    });
    expect(res.statusCode).toBe(401);
  });

  it("伪造签名 → 401", async () => {
    await seedUser(tmp.db);
    await loginAs(app, "alice", "password123");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: "gb_crm_sid=deadbeef.forgedsignature" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("session 不存在（已被删）→ 401", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    tmp.sqlite.prepare("DELETE FROM sessions").run();
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/v1/auth/logout", () => {
  it("204 + 删 session + 清 cookie；之后旧 cookie 失效", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["set-cookie"] as string).toMatch(/gb_crm_sid=;/);
    expect(tmp.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });

    const after = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it("未登录 logout → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /api/v1/auth/password", () => {
  it("旧密码错误 → 401 INVALID_CREDENTIALS", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/password",
      headers: { cookie },
      payload: { currentPassword: "nope-nope", newPassword: "newpassword1" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("成功 → 204；旧 session 全部失效；新密码可登录、旧密码不可", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    // 同一用户第二个 session（也应被删）
    const cookie2 = await loginAs(app, "alice", "password123");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/password",
      headers: { cookie },
      payload: { currentPassword: "password123", newPassword: "newpassword1" },
    });
    expect(res.statusCode).toBe(204);
    expect(tmp.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });

    for (const c of [cookie, cookie2]) {
      const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: c } });
      expect(me.statusCode).toBe(401);
    }
    expect((await login("alice", "password123")).statusCode).toBe(401);
    expect((await login("alice", "newpassword1")).statusCode).toBe(204);
  });

  it("newPassword 太短 → 422", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/password",
      headers: { cookie },
      payload: { currentPassword: "password123", newPassword: "short" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("登录限流与反代", () => {
  it("第 max+1 次 login → 429 RATE_LIMITED", async () => {
    await seedUser(tmp.db);
    const limited = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      rateLimitMax: 3,
      gcProbability: 0,
    });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await limited.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { username: "alice", password: "password123" },
        });
        expect(res.statusCode).toBe(204);
      }
      const res = await limited.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "alice", password: "password123" },
      });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({
        error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" },
      });
    } finally {
      await limited.close();
    }
  });

  it("TRUST_PROXY=false 时忽略 XFF（不同 XFF 共享 socket IP 桶）", async () => {
    await seedUser(tmp.db);
    const noTrust = buildApp({
      env: testEnv({ TRUST_PROXY: "false" }),
      db: tmp.db,
      now: () => clock.t,
      rateLimitMax: 1,
      gcProbability: 0,
    });
    try {
      const first = await noTrust.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "alice", password: "password123" },
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      expect(first.statusCode).toBe(204);
      // 伪造另一个 XFF 也躲不过限流 —— 键是 socket IP
      const second = await noTrust.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "alice", password: "password123" },
        headers: { "x-forwarded-for": "2.2.2.2" },
      });
      expect(second.statusCode).toBe(429);
    } finally {
      await noTrust.close();
    }
  });

  it("TRUST_PROXY=true 时按 XFF 第一跳分桶", async () => {
    await seedUser(tmp.db);
    const trusted = buildApp({
      env: testEnv({ TRUST_PROXY: "true" }),
      db: tmp.db,
      now: () => clock.t,
      rateLimitMax: 1,
      gcProbability: 0,
    });
    try {
      const payload = { username: "alice", password: "password123" };
      const a = await trusted.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload,
        headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" },
      });
      expect(a.statusCode).toBe(204);
      const b = await trusted.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload,
        headers: { "x-forwarded-for": "2.2.2.2" },
      });
      expect(b.statusCode).toBe(204); // 不同客户端 IP，独立桶
      const a2 = await trusted.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload,
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
      expect(a2.statusCode).toBe(429);
    } finally {
      await trusted.close();
    }
  });
});

describe("argon2id 参数钉住（Security 认证细节）", () => {
  it("hashPassword 输出 argon2id m=65536,t=3,p=1", async () => {
    const hash = await hashPassword("pin-down-params");
    // 编码参数顺序为 m,p,t（argon2 编码格式）
    expect(hash.startsWith("$argon2id$v=19$m=65536,p=1,t=3$")).toBe(true);
  });
});

describe("session GC", () => {
  it("login 时清掉过期 session（K29）", async () => {
    const id = await seedUser(tmp.db);
    // 插入一条已过期 session（别的用户场景同理，用同用户即可）；时间戳一律 epoch ms
    tmp.sqlite
      .prepare(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, last_touched_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("expired-session", id, clock.t - 100_000_000, clock.t - 50_000_000, clock.t - 50_000_000);
    // 插入一条超 7d 绝对上限但 idle 未到期的
    tmp.sqlite
      .prepare(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, last_touched_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ancient-session", id, clock.t - 8 * 86400 * 1000, clock.t + 3600 * 1000, clock.t);

    await loginAs(app, "alice", "password123");
    const ids = (tmp.sqlite.prepare("SELECT id FROM sessions").all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(ids).not.toContain("expired-session");
    expect(ids).not.toContain("ancient-session");
    expect(ids).toHaveLength(1); // 只剩本次 login 新建的
  });
});
