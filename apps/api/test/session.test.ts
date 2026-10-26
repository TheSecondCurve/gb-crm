import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loginAs, seedUser, setAccountStatus, testEnv } from "./helpers/auth.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

let tmp: TmpDb;
let clock: { t: number };
let app: FastifyInstance;

// 全库时间戳一律 epoch 毫秒
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

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

function sessionRow() {
  const row = tmp.sqlite.prepare("SELECT * FROM sessions").get() as {
    id: string;
    user_id: number;
    created_at: number;
    expires_at: number;
    last_touched_at: number;
  };
  return row;
}

describe("session touch 节流（K5）", () => {
  it("30min 内连续 GET /me：只读不写（expires_at / last_touched_at 不变，无新 Set-Cookie）", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const before = sessionRow();

    clock.t += 10 * 60 * 1000; // +10min
    const r1 = await me(cookie);
    clock.t += 10 * 60 * 1000; // +20min
    const r2 = await me(cookie);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.headers["set-cookie"]).toBeUndefined();
    expect(r2.headers["set-cookie"]).toBeUndefined();
    expect(sessionRow()).toEqual(before); // 一次都没写
  });

  it("30min 后 touch：expires_at=min(now+1y, created_at+10y)，last_touched_at=now，并刷新 cookie", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const before = sessionRow();

    clock.t += 31 * 60 * 1000;
    const res = await me(cookie);
    expect(res.statusCode).toBe(200);

    const after = sessionRow();
    expect(after.last_touched_at).toBe(clock.t);
    expect(after.expires_at).toBe(Math.min(clock.t + YEAR, before.created_at + 10 * YEAR));
    expect(after.expires_at).toBe(clock.t + YEAR); // 距 10y 绝对上限还远
    // cookie 刷新为剩余 idle（cookie 规范单位是秒：31536000 = 1y）
    expect(res.headers["set-cookie"] as string).toContain("Max-Age=31536000");
  });

  it("剩余 idle < 1y-1h 也触发 touch（即使 30min 内刚摸过）", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const row = sessionRow();
    // 直接操纵：刚 touch 过（30min 内不触发第一条），但 expires_at 只剩 1y-1h-1min
    tmp.sqlite
      .prepare("UPDATE sessions SET last_touched_at = ?, expires_at = ? WHERE id = ?")
      .run(clock.t, clock.t + YEAR - HOUR - 60_000, row.id);

    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    const after = sessionRow();
    expect(after.last_touched_at).toBe(clock.t);
    expect(after.expires_at).toBe(clock.t + YEAR);
  });

  it("touch 受 10y 绝对上限封顶：expires_at 不超过 created_at + 10y", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const row = sessionRow();
    // 创建于 10 年前差 2 天：绝对上限只剩 2 天（2 * DAY = 172800000ms，整数无舍入）
    tmp.sqlite
      .prepare("UPDATE sessions SET created_at = ?, last_touched_at = ? WHERE id = ?")
      .run(clock.t - (10 * YEAR - 2 * DAY), clock.t - 31 * 60 * 1000, row.id);

    const res = await me(cookie);
    expect(res.statusCode).toBe(200);
    const after = sessionRow();
    expect(after.expires_at).toBe(clock.t - (10 * YEAR - 2 * DAY) + 10 * YEAR);
    expect(after.expires_at).toBeLessThan(clock.t + YEAR);
    // cookie maxAge = 剩余 idle（ms → 秒）
    expect(res.headers["set-cookie"] as string).toContain(
      `Max-Age=${(after.expires_at - clock.t) / 1000}`,
    );
  });

  it("idle 到期（now >= expires_at）→ 401", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    clock.t += YEAR + 1;
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("超 10y 绝对上限 → 401（即使 idle 未到期）", async () => {
    await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    const row = sessionRow();
    // created_at 在 10 年前多 1ms；expires_at 仍在未来
    tmp.sqlite
      .prepare("UPDATE sessions SET created_at = ?, expires_at = ? WHERE id = ?")
      .run(clock.t - 10 * YEAR - 1, clock.t + HOUR, row.id);
    expect((await me(cookie)).statusCode).toBe(401);
  });
});

describe("禁用账户踢 session", () => {
  it("禁用后旧 session 立即 401", async () => {
    const id = await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    setAccountStatus(tmp.db, id, "disabled");
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("软删用户后旧 session 立即 401", async () => {
    const id = await seedUser(tmp.db);
    const cookie = await loginAs(app, "alice", "password123");
    tmp.sqlite.prepare("UPDATE users SET deleted_at = ? WHERE id = ?").run(clock.t, id);
    expect((await me(cookie)).statusCode).toBe(401);
  });
});

describe("带 cookie 请求的 1% GC（K29）", () => {
  it("gcProbability=1 时任意认证请求清掉过期 session", async () => {
    const gcApp = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 1,
    });
    try {
      const id = await seedUser(tmp.db);
      const cookie = await loginAs(gcApp, "alice", "password123");
      tmp.sqlite
        .prepare(
          "INSERT INTO sessions (id, user_id, created_at, expires_at, last_touched_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("stale", id, clock.t - 90_000_000, clock.t - 1_000_000, clock.t - 1_000_000);

      const res = await gcApp.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const ids = (tmp.sqlite.prepare("SELECT id FROM sessions").all() as { id: string }[]).map(
        (r) => r.id,
      );
      expect(ids).not.toContain("stale");
    } finally {
      await gcApp.close();
    }
  });
});
