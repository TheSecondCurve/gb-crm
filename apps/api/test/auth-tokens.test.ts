import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { canAllowedPageKeys } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { renderLoginScript } from "../src/modules/auth/login-script.js";
import { TOKEN_TTL_MS } from "../src/modules/auth/token-repo.js";
import { loginAs, seedUser, setAccountStatus, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: 1_800_000_000_000 };
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

const mint = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/v1/auth/tokens", payload });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /api/v1/auth/tokens", () => {
  it("用户名密码签发只读令牌：201，明文仅此一次，库内只存 hash", async () => {
    const userId = await seedUser(tmp.db);
    const res = await mint({
      username: "alice",
      password: "password123",
      scope: "read",
      name: "mba-agent",
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      token: string;
      prefix: string;
      scope: string;
      name: string;
      expiresAt: number;
    };
    expect(data.token).toMatch(/^gbcrm_ro_[0-9a-f]{64}$/);
    expect(data.prefix).toBe(data.token.slice(0, 17));
    expect(data.scope).toBe("read");
    expect(data.name).toBe("mba-agent");
    expect(data.expiresAt).toBe(clock.t + TOKEN_TTL_MS);

    const rows = tmp.sqlite.prepare("SELECT * FROM api_tokens").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: userId,
      token_prefix: data.prefix,
      scope: "read",
      name: "mba-agent",
      created_at: clock.t,
      expires_at: data.expiresAt,
      revoked_at: null,
    });
    expect(String(rows[0]!["token_hash"])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(data.token);
    expect(rows[0]!["token_hash"]).not.toBe(data.token);
  });

  it("write 令牌前缀为 gbcrm_rw_", async () => {
    await seedUser(tmp.db);
    const res = await mint({ username: "alice", password: "password123", scope: "write" });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.token).toMatch(/^gbcrm_rw_[0-9a-f]{64}$/);
    expect(res.json().data.scope).toBe("write");
  });

  it("密码错误 / 无角色 → 401 INVALID_CREDENTIALS，不签发", async () => {
    await seedUser(tmp.db);
    const wrong = await mint({ username: "alice", password: "nope", scope: "read" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({
      error: { code: "INVALID_CREDENTIALS", message: "用户名或密码错误" },
    });

    await seedUser(tmp.db, {
      username: "bob",
      systemRole: null,
      nickname: "无角色",
    });
    const noRole = await mint({ username: "bob", password: "password123", scope: "read" });
    expect(noRole.statusCode).toBe(401);
    expect(noRole.json().error.code).toBe("INVALID_CREDENTIALS");

    expect(tmp.sqlite.prepare("SELECT COUNT(*) AS n FROM api_tokens").get()).toEqual({ n: 0 });
  });

  it("body 不合法 → 422", async () => {
    const res = await mint({ username: "alice", password: "password123", scope: "admin" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("限流与 login 同档：第 max+1 次 → 429", async () => {
    await seedUser(tmp.db);
    const limited = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      rateLimitMax: 2,
      gcProbability: 0,
    });
    try {
      const payload = { username: "alice", password: "password123", scope: "read" };
      expect((await limited.inject({ method: "POST", url: "/api/v1/auth/tokens", payload })).statusCode).toBe(
        201,
      );
      expect((await limited.inject({ method: "POST", url: "/api/v1/auth/tokens", payload })).statusCode).toBe(
        201,
      );
      const third = await limited.inject({ method: "POST", url: "/api/v1/auth/tokens", payload });
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe("RATE_LIMITED");
    } finally {
      await limited.close();
    }
  });
});

describe("Bearer 认证", () => {
  it("read 令牌 GET /auth/me → 200，身份与 cookie 登录一致", async () => {
    const id = await seedUser(tmp.db);
    const minted = await mint({ username: "alice", password: "password123", scope: "read" });
    const token = minted.json().data.token as string;
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: {
        id,
        username: "alice",
        nickname: "爱丽丝",
        systemRole: "admin",
        impersonatedBy: null,
        pages: canAllowedPageKeys("admin"),
      },
    });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("伪造 / 过期 / 已撤销 → 401；有 Bearer 时不回落到 cookie", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const minted = await mint({ username: "alice", password: "password123", scope: "read" });
    const token = minted.json().data.token as string;

    const forged = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { ...bearer("gbcrm_ro_" + "ab".repeat(32)), cookie },
    });
    expect(forged.statusCode).toBe(401);

    tmp.sqlite.prepare("UPDATE api_tokens SET expires_at = ?").run(clock.t - 1);
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bearer(token),
    });
    expect(expired.statusCode).toBe(401);

    tmp.sqlite.prepare("UPDATE api_tokens SET expires_at = ?, revoked_at = ?").run(clock.t + TOKEN_TTL_MS, clock.t);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bearer(token),
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("禁用账户后令牌立即 401", async () => {
    const id = await seedUser(tmp.db);
    const minted = await mint({ username: "alice", password: "password123", scope: "write" });
    const token = minted.json().data.token as string;
    setAccountStatus(tmp.db, id, "disabled");
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });
    expect(res.statusCode).toBe(401);
  });

  it("管理员 PATCH 禁用用户会撤销其令牌", async () => {
    const adminId = await seedUser(tmp.db);
    await seedUser(tmp.db, { username: "bob", nickname: "鲍勃" });
    const bobToken = (await mint({ username: "bob", password: "password123", scope: "read" })).json()
      .data.token as string;
    const cookie = await loginAs(app, "alice", "password123");
    const bob = (
      await app.inject({ method: "GET", url: "/api/v1/users", headers: { cookie } })
    ).json().data.find((u: { username: string }) => u.username === "bob") as {
      id: number;
      updatedAt: number;
    };
    expect(adminId).toBeGreaterThan(0);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/users/${bob.id}`,
      headers: { cookie },
      payload: { accountStatus: "disabled", updatedAt: bob.updatedAt },
    });
    expect(patched.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(bobToken) });
    expect(me.statusCode).toBe(401);
    const revoked = tmp.sqlite
      .prepare("SELECT revoked_at FROM api_tokens WHERE user_id = ?")
      .get(bob.id) as { revoked_at: number };
    expect(revoked.revoked_at).toBe(clock.t);
  });
});

describe("read / write 范围", () => {
  it("read 令牌 GET 客户列表 200；POST/PATCH 403", async () => {
    await seedUser(tmp.db);
    const token = (await mint({ username: "alice", password: "password123", scope: "read" })).json()
      .data.token as string;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: bearer(token),
      payload: { nickname: "不应创建" },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error).toMatchObject({
      code: "FORBIDDEN",
      message: "此令牌为只读，无法执行写操作",
    });
  });

  it("write 令牌可 POST 客户；仍受 can()：助手 POST 客户 403", async () => {
    await seedUser(tmp.db);
    const adminToken = (await mint({ username: "alice", password: "password123", scope: "write" }))
      .json().data.token as string;
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: bearer(adminToken),
      payload: { nickname: "令牌客户" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.nickname).toBe("令牌客户");

    await seedUser(tmp.db, { username: "helper", systemRole: "assistant", nickname: "助手" });
    const helperToken = (
      await mint({ username: "helper", password: "password123", scope: "write" })
    ).json().data.token as string;
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: bearer(helperToken),
      payload: { nickname: "助手不该建" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe("没有权限执行此操作");
  });

  it("cookie 会话不受令牌范围限制（浏览器仍可写）", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: { cookie },
      payload: { nickname: "浏览器客户" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("GET/DELETE /api/v1/auth/tokens", () => {
  it("列出自己的令牌，不含 hash/明文；可撤销；read 令牌允许撤销自己", async () => {
    await seedUser(tmp.db);
    const minted = await mint({
      username: "alice",
      password: "password123",
      scope: "read",
      name: "laptop",
    });
    const token = minted.json().data.token as string;
    const prefix = minted.json().data.prefix as string;

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/auth/tokens",
      headers: bearer(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0]).toMatchObject({
      prefix,
      scope: "read",
      name: "laptop",
      revokedAt: null,
    });
    expect(JSON.stringify(list.json())).not.toContain(token);
    expect(list.json().data[0].tokenHash).toBeUndefined();
    expect(list.json().data[0].token).toBeUndefined();

    const id = list.json().data[0].id as number;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${id}`,
      headers: bearer(token),
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bearer(token),
    });
    expect(after.statusCode).toBe(401);
  });

  it("不能撤销别人的令牌（404）", async () => {
    await seedUser(tmp.db);
    const aliceMint = await mint({ username: "alice", password: "password123", scope: "write" });
    const aliceId = (
      await app.inject({
        method: "GET",
        url: "/api/v1/auth/tokens",
        headers: bearer(aliceMint.json().data.token),
      })
    ).json().data[0].id as number;

    await seedUser(tmp.db, { username: "bob", nickname: "鲍勃" });
    const bobToken = (await mint({ username: "bob", password: "password123", scope: "write" })).json()
      .data.token as string;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${aliceId}`,
      headers: bearer(bobToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /agent/login.sh", () => {
  it("免登录返回脚本，并把 Host 写成默认 baseUrl", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/login.sh",
      headers: { host: "crm.internal:3001" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.body).toContain("http://crm.internal:3001");
    expect(res.body).toContain("/api/v1/auth/tokens");
    expect(res.body).toContain(".gb-crm");
    expect(res.body).toContain("credentials.json");
    expect(res.body).toContain("/dev/tty");
  });

  it("非法 Host 不写入脚本（防注入），回退本地默认", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/login.sh",
      headers: { host: "evil.com; rm -rf /" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("rm -rf");
    expect(res.body).toContain("http://127.0.0.1:3001");
  });

  it("renderLoginScript 拒绝非 http(s) URL", () => {
    const script = renderLoginScript("javascript:alert(1)");
    expect(script).toContain("http://127.0.0.1:3001");
    expect(script).not.toContain("javascript:");
  });

  it("非交互 env 可对本机 listen 签发并写入 ~/.gb-crm/credentials.json", async () => {
    await seedUser(tmp.db);
    const listening = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
    });
    await listening.listen({ host: "127.0.0.1", port: 0 });
    const addr = listening.server.address();
    if (addr === null || typeof addr === "string") throw new Error("expected tcp address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "gb-crm-home-"));
    const scriptPath = path.join(home, "login.sh");
    try {
      const script = await listening.inject({
        method: "GET",
        url: "/agent/login.sh",
        headers: { host: `127.0.0.1:${addr.port}` },
      });
      fs.writeFileSync(scriptPath, script.body, { mode: 0o700 });
      // 必须异步 spawn：execFileSync 会堵住本进程事件循环，脚本 HTTP 打回 Fastify 会死锁
      const { stdout } = await execFileAsync("sh", [scriptPath], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          GB_CRM_USERNAME: "alice",
          GB_CRM_PASSWORD: "password123",
          GB_CRM_SCOPE: "read",
          GB_CRM_BASE_URL: baseUrl,
          http_proxy: "",
          https_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
        },
        encoding: "utf8",
        timeout: 20_000,
      });
      const credPath = path.join(home, ".gb-crm", "credentials.json");
      const cred = JSON.parse(fs.readFileSync(credPath, "utf8")) as {
        baseUrl: string;
        token: string;
        scope: string;
        username: string;
      };
      expect(cred).toMatchObject({ baseUrl, scope: "read", username: "alice" });
      expect(cred.token).toMatch(/^gbcrm_ro_[0-9a-f]{64}$/);
      expect(fs.statSync(path.join(home, ".gb-crm")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(credPath).mode & 0o777).toBe(0o600);
      expect(stdout).not.toContain(cred.token);
      expect(stdout).toContain("已写入");

      const me = await listening.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: bearer(cred.token),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().data.username).toBe("alice");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      await listening.close();
    }
  });
});

describe("授权管理（admin）GET/DELETE /api/v1/auth/tokens/admin", () => {
  // POST /auth/tokens 响应不含 id（只有 prefix）；用 prefix 查 api_tokens 拿真实 id
  const idOfPrefix = (prefix: string): number =>
    (tmp.sqlite
      .prepare("SELECT id FROM api_tokens WHERE token_prefix = ?")
      .get(prefix) as { id: number }).id;

  it("admin 可列全部令牌：含用户昵称/scope/派生状态，无 hash/明文", async () => {
    await seedUser(tmp.db);
    const bobUserId = await seedUser(tmp.db, { username: "bob", nickname: "鲍勃" });
    const a = await mint({ username: "alice", password: "password123", scope: "read", name: "laptop" });
    const b = await mint({ username: "bob", password: "password123", scope: "write" });
    const c = await mint({ username: "bob", password: "password123", scope: "read" });
    const aId = idOfPrefix(a.json().data.prefix);
    const bId = idOfPrefix(b.json().data.prefix);
    const cId = idOfPrefix(c.json().data.prefix);

    // 制造衍生状态：a=已过期（未吊销）、b=已吊销、c=有效（不动）
    tmp.sqlite.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?").run(clock.t - 1, aId);
    tmp.sqlite.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(clock.t, bId);

    const cookie = await loginAs(app, "alice", "password123");
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/tokens/admin", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(3);
    type AdminTokenRow = {
      id: number;
      status: string;
      scope: string;
      name: string | null;
      prefix: string;
      user: { id: number; nickname: string };
      token?: string;
      tokenHash?: string;
    };
    const byId = Object.fromEntries(
      (body.data as AdminTokenRow[]).map((r) => [r.id, r]),
    ) as Record<number, AdminTokenRow>;
    const rowA = byId[aId]!;
    const rowB = byId[bId]!;
    const rowC = byId[cId]!;
    expect(rowA).toMatchObject({ status: "expired", scope: "read", name: "laptop", prefix: a.json().data.prefix });
    expect(rowB).toMatchObject({ status: "revoked", scope: "write" });
    expect(rowC).toMatchObject({ status: "active", scope: "read" });
    expect(rowA.user).toEqual({ id: rowA.user.id, nickname: "爱丽丝" });
    expect(rowB.user).toEqual({ id: bobUserId, nickname: "鲍勃" });
    expect(JSON.stringify(body)).not.toContain(a.json().data.token);
    expect(rowA.tokenHash).toBeUndefined();
    expect(rowA.token).toBeUndefined();
  });

  it("operator/assistant → 403；未登录 → 401", async () => {
    await seedUser(tmp.db);
    await seedUser(tmp.db, { username: "op", systemRole: "operator", nickname: "运营" });
    const opCookie = await loginAs(app, "op", "password123");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/auth/tokens/admin",
      headers: { cookie: opCookie },
    });
    expect(listRes.statusCode).toBe(403);

    const delRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/tokens/admin/1",
      headers: { cookie: opCookie },
    });
    expect(delRes.statusCode).toBe(403);

    const anon = await app.inject({ method: "GET", url: "/api/v1/auth/tokens/admin" });
    expect(anon.statusCode).toBe(401);
  });

  it("admin 吊销他人令牌：revoked_at/revoked_by 写入，令牌随即失效", async () => {
    const adminId = await seedUser(tmp.db);
    await seedUser(tmp.db, { username: "bob", nickname: "鲍勃" });
    const bobMint = await mint({ username: "bob", password: "password123", scope: "write" });
    const bobToken = bobMint.json().data.token as string;
    const bobId = idOfPrefix(bobMint.json().data.prefix);

    const cookie = await loginAs(app, "alice", "password123");
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/admin/${bobId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const row = tmp.sqlite
      .prepare("SELECT revoked_at, revoked_by FROM api_tokens WHERE id = ?")
      .get(bobId) as { revoked_at: number; revoked_by: number };
    expect(row.revoked_at).toBe(clock.t);
    expect(row.revoked_by).toBe(adminId);

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(bobToken) });
    expect(me.statusCode).toBe(401);
  });

  it("吊销不存在 id → 404；已吊销 → 幂等 204 且不改 revoked_by", async () => {
    await seedUser(tmp.db);
    await seedUser(tmp.db, { username: "bob", nickname: "鲍勃" });
    const bobMint = await mint({ username: "bob", password: "password123", scope: "write" });
    const bobId = idOfPrefix(bobMint.json().data.prefix);
    const cookie = await loginAs(app, "alice", "password123");

    const missing = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/tokens/admin/999999",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);

    const first = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/admin/${bobId}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(204);
    const second = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/admin/${bobId}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(204);

    const row = tmp.sqlite.prepare("SELECT revoked_by FROM api_tokens WHERE id = ?").get(bobId) as {
      revoked_by: number;
    };
    expect(row.revoked_by).toBeGreaterThan(0);
  });

  it("按 status/scope/userId 过滤生效", async () => {
    await seedUser(tmp.db);
    const bobId = await seedUser(tmp.db, { username: "bob", nickname: "鲍勃" });
    const a = await mint({ username: "alice", password: "password123", scope: "read" });
    const aId = idOfPrefix(a.json().data.prefix);
    await mint({ username: "bob", password: "password123", scope: "read" });
    await mint({ username: "bob", password: "password123", scope: "write" });
    tmp.sqlite.prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ?").run(clock.t, aId);

    const cookie = await loginAs(app, "alice", "password123");
    const get = async (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

    const revokedOnly = await get("/api/v1/auth/tokens/admin?status=revoked");
    expect(revokedOnly.json().meta.total).toBe(1);
    expect(revokedOnly.json().data[0].id).toBe(aId);

    const activeOnly = await get("/api/v1/auth/tokens/admin?status=active");
    expect(activeOnly.json().meta.total).toBe(2);

    const readScope = await get("/api/v1/auth/tokens/admin?scope=read");
    expect(readScope.json().meta.total).toBe(2);

    const bobAll = await get(`/api/v1/auth/tokens/admin?userId=${bobId}`);
    expect(bobAll.json().meta.total).toBe(2);

    const bobWrite = await get(`/api/v1/auth/tokens/admin?userId=${bobId}&scope=write`);
    expect(bobWrite.json().meta.total).toBe(1);
    expect(bobWrite.json().data[0].scope).toBe("write");
  });
});
