// K49 admin「扮演用户（act as user）」端到端测试。
// 机制：改写当前 cookie session 行（user_id → 目标，impersonated_by → 原 admin），退出时恢复。
// 覆盖：401/403（角色、Bearer PAT）、目标列表闸门、扮演后身份与权限生效、409 冲突、
// 目标不可用 422、退出恢复、「我的运营」按 ownerId 过滤端到端。
import { canAllowedPageKeys } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loginAs, seedUser, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

const TARGETS_URL = "/api/v1/auth/impersonate/targets";
const STOP_URL = "/api/v1/auth/impersonate/stop";

beforeEach(() => {
  tmp = createTmpDb();
  clock = { t: 1_800_000_000_000 }; // 固定起点（epoch ms），避免依赖真实时间
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

const me = (cookie: string) =>
  app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });

const startImpersonate = (cookie: string, userId: number) =>
  app.inject({
    method: "POST",
    url: `/api/v1/auth/impersonate/${userId}`,
    headers: { cookie },
  });

const stopImpersonate = (cookie: string) =>
  app.inject({ method: "POST", url: STOP_URL, headers: { cookie } });

async function seedFixture() {
  const adminId = await seedUser(tmp.db, {
    username: "admin",
    nickname: "管理员",
    systemRole: "admin",
  });
  const operatorId = await seedUser(tmp.db, {
    username: "ops",
    nickname: "运营",
    systemRole: "operator",
  });
  const assistantId = await seedUser(tmp.db, {
    username: "assistant",
    nickname: "兼职助手",
    systemRole: "assistant",
  });
  const disabledId = await seedUser(tmp.db, {
    username: "disabled",
    nickname: "停用账户",
    systemRole: "operator",
    accountStatus: "disabled",
  });
  const noRoleId = await seedUser(tmp.db, {
    username: "norole",
    nickname: "无角色",
    systemRole: null,
  });
  const deletedId = await seedUser(tmp.db, {
    username: "deleted",
    nickname: "已删除",
    systemRole: "operator",
    deletedAt: clock.t,
  });
  return { adminId, operatorId, assistantId, disabledId, noRoleId, deletedId };
}

/** 直插客户行（仅测试需要的列；默认值由 SQL 缺省补齐） */
function insertCustomer(ownerId: number, nickname: string): number {
  const r = tmp.sqlite
    .prepare("INSERT INTO customers (nickname, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(nickname, ownerId, clock.t, clock.t);
  return Number(r.lastInsertRowid);
}

describe("GET /api/v1/auth/impersonate/targets", () => {
  it("未登录 → 401", async () => {
    const res = await app.inject({ method: "GET", url: TARGETS_URL });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("operator / assistant → 403（矩阵仅 admin）", async () => {
    const ids = await seedFixture();
    for (const uid of [ids.operatorId, ids.assistantId]) {
      const cookie = await loginAs(app, uid === ids.operatorId ? "ops" : "assistant", "password123");
      const res = await app.inject({ method: "GET", url: TARGETS_URL, headers: { cookie } });
      expect(res.statusCode).toBe(403);
    }
  });

  it("admin Bearer PAT → 403（扮演仅 cookie session）", async () => {
    await seedFixture();
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      payload: { username: "admin", password: "password123", scope: "write", name: "t" },
    });
    const token = minted.json().data.token as string;
    const res = await app.inject({
      method: "GET",
      url: TARGETS_URL,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin → 含可加载用户，排除自己 / disabled / 软删 / 无角色", async () => {
    const ids = await seedFixture();
    const cookie = await loginAs(app, "admin", "password123");
    const res = await app.inject({ method: "GET", url: TARGETS_URL, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json().data as { id: number; username: string; nickname: string; systemRole: string }[];
    const seen = list.map((u) => u.id).sort();
    expect(seen).toEqual([ids.operatorId, ids.assistantId].sort());
    expect(list.find((u) => u.id === ids.operatorId)).toMatchObject({
      username: "ops",
      nickname: "运营",
      systemRole: "operator",
    });
  });
});

describe("POST /api/v1/auth/impersonate/:id", () => {
  it("未登录 → 401；operator → 403", async () => {
    const ids = await seedFixture();
    const anon = await app.inject({ method: "POST", url: `/api/v1/auth/impersonate/${ids.assistantId}` });
    expect(anon.statusCode).toBe(401);
    const opCookie = await loginAs(app, "ops", "password123");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/auth/impersonate/${ids.assistantId}`,
      headers: { cookie: opCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin Bearer PAT → 403", async () => {
    const ids = await seedFixture();
    const minted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      payload: { username: "admin", password: "password123", scope: "write", name: "t" },
    });
    const token = minted.json().data.token as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/auth/impersonate/${ids.assistantId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("成功 → 204；/auth/me 变为目标身份并带 impersonatedBy；权限按目标角色生效", async () => {
    const ids = await seedFixture();
    const cookie = await loginAs(app, "admin", "password123");

    const start = await startImpersonate(cookie, ids.assistantId);
    expect(start.statusCode).toBe(204);

    const m = await me(cookie);
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({
      data: {
        id: ids.assistantId,
        username: "assistant",
        nickname: "兼职助手",
        systemRole: "assistant",
        impersonatedBy: { id: ids.adminId, nickname: "管理员" },
        pages: canAllowedPageKeys("assistant"),
      },
    });

    // 有效角色已切换：assistant 不能建用户（admin 才可以）
    const createUser = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { cookie },
      payload: { username: "newbie", nickname: "新人", systemRole: "operator" },
    });
    expect(createUser.statusCode).toBe(403);

    // sessions 行留痕：user_id = 目标、impersonated_by = admin
    const row = tmp.sqlite.prepare("SELECT user_id, impersonated_by FROM sessions").get() as {
      user_id: number;
      impersonated_by: number | null;
    };
    expect(row).toEqual({ user_id: ids.assistantId, impersonated_by: ids.adminId });
  });

  it("扮演后「我的运营」按 ownerId 过滤生效（端到端）", async () => {
    const ids = await seedFixture();
    const cookie = await loginAs(app, "admin", "password123");
    const mine = insertCustomer(ids.assistantId, "助手客户");
    insertCustomer(ids.operatorId, "运营客户"); // 不属于目标，不应出现

    await startImpersonate(cookie, ids.assistantId);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/customers?ownerId=${ids.assistantId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { id: number }[]; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe(mine);
  });

  it("扮演自己 → 409；已扮演再 start → 403（弱角色）/ 409（强角色）", async () => {
    const ids = await seedFixture();
    const admin2Id = await seedUser(tmp.db, {
      username: "admin2",
      nickname: "管理员二号",
      systemRole: "admin",
    });
    const cookie = await loginAs(app, "admin", "password123");

    const self = await startImpersonate(cookie, ids.adminId);
    expect(self.statusCode).toBe(409);

    // 嵌套扮演一律被拦：扮成 assistant（弱角色）→ requireCan 403；扮成 admin（强角色）→ service 409
    await startImpersonate(cookie, ids.assistantId);
    const weak = await startImpersonate(cookie, ids.operatorId);
    expect(weak.statusCode).toBe(403);

    await stopImpersonate(cookie);
    await startImpersonate(cookie, admin2Id);
    const strong = await startImpersonate(cookie, ids.operatorId);
    expect(strong.statusCode).toBe(409);
    expect(strong.json().error.code).toBe("CONFLICT");
  });

  it("目标 disabled / 软删 / 无角色 / 不存在 → 422", async () => {
    const ids = await seedFixture();
    const cookie = await loginAs(app, "admin", "password123");
    for (const uid of [ids.disabledId, ids.noRoleId, ids.deletedId, 999_999]) {
      const res = await startImpersonate(cookie, uid);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION");
    }
  });
});

describe("POST /api/v1/auth/impersonate/stop", () => {
  it("未登录 → 401；未扮演时 stop → 409", async () => {
    await seedFixture();
    const anon = await app.inject({ method: "POST", url: STOP_URL });
    expect(anon.statusCode).toBe(401);
    const cookie = await loginAs(app, "admin", "password123");
    const res = await stopImpersonate(cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("扮演 assistant 后 stop → 204 恢复 admin（弱角色也可自行退出）", async () => {
    const ids = await seedFixture();
    const cookie = await loginAs(app, "admin", "password123");
    await startImpersonate(cookie, ids.assistantId);

    const stop = await stopImpersonate(cookie);
    expect(stop.statusCode).toBe(204);

    const m = await me(cookie);
    expect(m.json()).toEqual({
      data: {
        id: ids.adminId,
        username: "admin",
        nickname: "管理员",
        systemRole: "admin",
        impersonatedBy: null,
        pages: canAllowedPageKeys("admin"),
      },
    });

    // 恢复后 admin 权限可用（能建用户），会话未丢
    const createUser = await app.inject({
      method: "POST",
      url: "/api/v1/users",
      headers: { cookie },
      payload: { username: "newbie", nickname: "新人", systemRole: "operator" },
    });
    expect(createUser.statusCode).toBe(201);
    const row = tmp.sqlite.prepare("SELECT impersonated_by FROM sessions").get() as {
      impersonated_by: number | null;
    };
    expect(row.impersonated_by).toBeNull();
  });

  it("扮演中 logout → 204；旧 cookie 失效，session 已删", async () => {
    const ids = await seedFixture();
    const cookie = await loginAs(app, "admin", "password123");
    await startImpersonate(cookie, ids.assistantId);

    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(tmp.sqlite.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});
