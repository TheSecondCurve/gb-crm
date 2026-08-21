// POST /api/v1/agent/sql：Agent 单一自由 SQL 端点（K35，2026-08-21 产品拍板）。
// 仅 Bearer PAT 可用；stmt.readonly 判定读写；写 SQL 需 write scope + admin。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loginAs, seedUser, testEnv } from "./helpers/auth.js";
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

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function mintToken(username: string, scope: "read" | "write"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/tokens",
    payload: { username, password: "password123", scope },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.token as string;
}

const runSql = (sql: string, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/v1/agent/sql", headers, payload: { sql } });

describe("POST /api/v1/agent/sql · 读", () => {
  it("read 令牌 SELECT：columns 有序、rows 为数组、rowCount 与 truncated", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");

    const res = await runSql(
      "SELECT id, username, nickname FROM users WHERE deleted_at IS NULL",
      bearer(token),
    );
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.columns).toEqual(["id", "username", "nickname"]);
    expect(data.rows).toEqual([[1, "alice", "爱丽丝"]]);
    expect(data.rowCount).toBe(1);
    expect(data.truncated).toBe(false);
  });

  it("超过 1000 行截断：rows/rowCount=1000，truncated=true", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");
    const insert = tmp.sqlite.prepare(
      "INSERT INTO customers (nickname, created_at, updated_at) VALUES (?, ?, ?)",
    );
    const seedMany = tmp.sqlite.transaction(() => {
      for (let i = 0; i < 1001; i += 1) insert.run(`客户${i}`, clock.t, clock.t);
    });
    seedMany();

    const res = await runSql("SELECT id FROM customers ORDER BY id", bearer(token));
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.columns).toEqual(["id"]);
    expect(data.rows).toHaveLength(1000);
    expect(data.rowCount).toBe(1000);
    expect(data.truncated).toBe(true);
  });

  it("assistant + read 令牌可查渠道密钥列（查询对所有角色全量开放）", async () => {
    await seedUser(tmp.db, { username: "helper", systemRole: "assistant", nickname: "助手" });
    const token = await mintToken("helper", "read");
    tmp.sqlite
      .prepare(
        "INSERT INTO channels (name, account_id, register_phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("主公众号", "gh_secret", "13800000000", clock.t, clock.t);

    const res = await runSql(
      "SELECT account_id, register_phone FROM channels",
      bearer(token),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rows).toEqual([["gh_secret", "13800000000"]]);
  });

  it("WITH...SELECT 与 PRAGMA 均 readonly=true，任意令牌可执行", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");

    const withRes = await runSql("WITH x AS (SELECT 1 AS n) SELECT * FROM x", bearer(token));
    expect(withRes.statusCode).toBe(200);
    expect(withRes.json().data.rows).toEqual([[1]]);

    const pragma = await runSql("PRAGMA table_info(users)", bearer(token));
    expect(pragma.statusCode).toBe(200);
    expect(pragma.json().data.columns).toContain("name");
  });
});

describe("POST /api/v1/agent/sql · 写", () => {
  it("read 令牌 INSERT → 403 仅管理员可执行写 SQL", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");
    const res = await runSql(
      `INSERT INTO customers (nickname, created_at, updated_at) VALUES ('x', ${clock.t}, ${clock.t})`,
      bearer(token),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: "FORBIDDEN", message: "仅管理员可执行写 SQL" });
  });

  it("INSERT...RETURNING 判为写：read 令牌 → 403", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");
    const res = await runSql(
      `INSERT INTO customers (nickname, created_at, updated_at) VALUES ('x', ${clock.t}, ${clock.t}) RETURNING id`,
      bearer(token),
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("write 令牌但 operator / assistant → UPDATE 403", async () => {
    await seedUser(tmp.db);
    await seedUser(tmp.db, { username: "ops", systemRole: "operator", nickname: "运营" });
    await seedUser(tmp.db, { username: "helper", systemRole: "assistant", nickname: "助手" });
    const opsToken = await mintToken("ops", "write");
    const helperToken = await mintToken("helper", "write");
    const sql = "UPDATE users SET nickname = '改名' WHERE id = 1";

    const ops = await runSql(sql, bearer(opsToken));
    expect(ops.statusCode).toBe(403);
    expect(ops.json().error.message).toBe("仅管理员可执行写 SQL");
    const helper = await runSql(sql, bearer(helperToken));
    expect(helper.statusCode).toBe(403);
    // 都没写成
    expect(tmp.sqlite.prepare("SELECT nickname FROM users WHERE id = 1").get()).toEqual({
      nickname: "爱丽丝",
    });
  });

  it("admin + write 令牌 INSERT/UPDATE 成功，返回 changes 与 lastInsertRowid", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "write");

    const ins = await runSql(
      `INSERT INTO customers (nickname, created_at, updated_at) VALUES ('写入客户', ${clock.t}, ${clock.t})`,
      bearer(token),
    );
    expect(ins.statusCode).toBe(200);
    expect(ins.json().data).toEqual({ changes: 1, lastInsertRowid: 1 });

    const upd = await runSql("UPDATE customers SET nickname = '改后' WHERE id = 1", bearer(token));
    expect(upd.statusCode).toBe(200);
    expect(upd.json().data).toMatchObject({ changes: 1 });
    expect(tmp.sqlite.prepare("SELECT nickname FROM customers WHERE id = 1").get()).toEqual({
      nickname: "改后",
    });
  });

  it("admin + write 执行 DDL（CREATE TABLE）不额外拦", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "write");
    const res = await runSql("CREATE TABLE scratch (id INTEGER PRIMARY KEY)", bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.changes).toBe(0);
    expect(
      tmp.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'scratch'").get(),
    ).toEqual({ name: "scratch" });
  });

  it("写违反约束 → 422 SQL_ERROR，事务回滚不落库", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "write");
    // users_username_live_uq：live 用户 username 唯一
    const res = await runSql(
      `INSERT INTO users (username, nickname, created_at, updated_at) VALUES ('alice', '重名', ${clock.t}, ${clock.t})`,
      bearer(token),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SQL_ERROR");
    expect(res.json().error.message).toContain("UNIQUE");
    expect(tmp.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });
});

describe("POST /api/v1/agent/sql · 鉴权与校验", () => {
  it("cookie session（web 登录）调用 → 403", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const res = await runSql("SELECT 1", { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("未登录 → 401", async () => {
    const res = await runSql("SELECT 1", {});
    expect(res.statusCode).toBe(401);
  });

  it("多语句 → 422 SQL_ERROR", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "write");
    const res = await runSql("SELECT 1; SELECT 2", bearer(token));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SQL_ERROR");
    expect(res.json().error.message).toContain("more than one statement");
  });

  it("语法错误 → 422 SQL_ERROR，带 sqlite 错误信息", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");
    const res = await runSql("SELEC bad", bearer(token));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("SQL_ERROR");
    expect(res.json().error.message).toContain("syntax error");
  });

  it("sql 缺失或为空 → 422 VALIDATION", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");
    const empty = await runSql("", bearer(token));
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe("VALIDATION");

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/agent/sql",
      headers: bearer(token),
      payload: {},
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe("VALIDATION");
  });

  it("read 令牌 POST /agent/sql 不被 session-auth 的只读闸门挡在路由外", async () => {
    await seedUser(tmp.db);
    const token = await mintToken("alice", "read");
    // 若例外没生效，这里会在钩子阶段 403「此令牌为只读，无法执行写操作」
    const res = await runSql("SELECT 1 AS n", bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rows).toEqual([[1]]);
  });
});
