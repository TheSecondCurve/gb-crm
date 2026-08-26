// K52 定时任务（job-schedules）：仅 admin CRUD / cron 校验 / 调度器 tick 物化队列行 / 立即执行 / 与 runner 集成。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { systemConfigs } from "../../src/db/schema.js";
import { cronNext } from "../../src/lib/cron.js";
import { createJobRunner } from "../../src/modules/jobs/runner.js";
import { createJobScheduler } from "../../src/modules/jobs/scheduler.js";
import { loginAs, seedUser, testEnv } from "../helpers/auth.js";
import { createTmpDb, type TmpDb } from "../helpers/tmp-db.js";

process.env.TZ = "UTC";

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

async function loginAsRole(role: "admin" | "operator" | "assistant") {
  const username = `u-${role}`;
  await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  return loginAs(app, username, "password123");
}

function seedAiConfigRow(): void {
  tmp.db
    .insert(systemConfigs)
    .values({
      code: "llm",
      value: JSON.stringify({ provider: "test", baseUrl: "https://llm.example/v1", apiKey: "sk-test-key", model: "m1" }),
      updatedAt: clock.t,
      updatedBy: null,
    })
    .onConflictDoNothing()
    .run();
}

const post = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, payload });
const postNoCookie = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, payload });
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });
const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) =>
  app.inject({ method: "DELETE", url, headers: { cookie } });

async function createSchedule(cookie: string, body: Record<string, unknown> = {}) {
  const res = await post("/api/v1/job-schedules", cookie, { type: "customer-tags-generate-all", cron: "0 2 * * *", ...body });
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: number; nextRunAt: number; enabled: boolean; cron: string; typeLabel: string | null };
}

describe("创建调度", () => {
  it("未登录 401；operator/assistant → 403；admin 201 且 nextRunAt 已算出", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const operator = await loginAsRole("operator");
    const assistant = await loginAsRole("assistant");

    expect((await post("/api/v1/job-schedules", admin, { type: "customer-tags-generate-all", cron: "0 2 * * *" })).statusCode).toBe(201);
    expect((await postNoCookie("/api/v1/job-schedules", { type: "customer-tags-generate-all", cron: "0 2 * * *" })).statusCode).toBe(401);
    expect((await post("/api/v1/job-schedules", operator, { type: "customer-tags-generate-all", cron: "0 2 * * *" })).statusCode).toBe(403);
    expect((await post("/api/v1/job-schedules", assistant, { type: "customer-tags-generate-all", cron: "0 2 * * *" })).statusCode).toBe(403);
    expect((await get("/api/v1/job-schedules", operator)).statusCode).toBe(403);
  });

  it("合法创建：nextRunAt = cronNext(cron, now)、enabled=true、typeLabel 正确", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin);
    expect(sched.enabled).toBe(true);
    expect(sched.cron).toBe("0 2 * * *");
    expect(sched.nextRunAt).toBe(cronNext("0 2 * * *", clock.t));
    expect(sched.typeLabel).toBe("全量生成客户标签");
  });

  it("未知 type → 422；非法 cron → 422；不可达 cron（2 月 31 日）→ 422", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    expect((await post("/api/v1/job-schedules", admin, { type: "nope", cron: "0 2 * * *" })).statusCode).toBe(422);
    expect((await post("/api/v1/job-schedules", admin, { type: "customer-tags-generate-all", cron: "not a cron" })).statusCode).toBe(422);
    expect((await post("/api/v1/job-schedules", admin, { type: "customer-tags-generate-all", cron: "0 0 31 2 *" })).statusCode).toBe(422);
  });

  it("非法 params → 422；LLM 未配置 → 422（预检）", async () => {
    const admin = await loginAsRole("admin");
    expect((await post("/api/v1/job-schedules", admin, { type: "customer-tags-generate-all", cron: "0 2 * * *", params: { q: 123 } })).statusCode).toBe(422);
    const unconfigured = await post("/api/v1/job-schedules", admin, { type: "customer-tags-generate-all", cron: "0 2 * * *" });
    expect(unconfigured.statusCode).toBe(422);
    expect(unconfigured.json().error.message).toContain("系统设置");
  });

  it("合法筛选 params 创建成功并保存规范化值", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const res = await post("/api/v1/job-schedules", admin, { type: "customer-tags-generate-all", cron: "0 2 * * *", params: { q: "关键词" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.params).toEqual({ q: "关键词" });
  });
});

describe("更新/删除调度", () => {
  it("PATCH enabled=false → nextRunAt 置空；再启用 → 重算", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin);
    const off = await patch(`/api/v1/job-schedules/${sched.id}`, admin, { enabled: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.enabled).toBe(false);
    expect(off.json().data.nextRunAt).toBeNull();

    const on = await patch(`/api/v1/job-schedules/${sched.id}`, admin, { enabled: true });
    expect(on.json().data.enabled).toBe(true);
    expect(on.json().data.nextRunAt).toBe(cronNext("0 2 * * *", clock.t));
  });

  it("PATCH 改写 cron 会重算 nextRunAt；非法 cron → 422；改未知 type → 422", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin);
    const changed = await patch(`/api/v1/job-schedules/${sched.id}`, admin, { cron: "30 5 * * *" });
    expect(changed.json().data.cron).toBe("30 5 * * *");
    expect(changed.json().data.nextRunAt).toBe(cronNext("30 5 * * *", clock.t));
    expect((await patch(`/api/v1/job-schedules/${sched.id}`, admin, { cron: "not a cron" })).statusCode).toBe(422);
    expect((await patch(`/api/v1/job-schedules/${sched.id}`, admin, { type: "nope" })).statusCode).toBe(422);
  });

  it("PATCH/DELETE 不存在 → 404；DELETE 后 GET → 404", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    expect((await patch("/api/v1/job-schedules/9999", admin, { enabled: false })).statusCode).toBe(404);
    expect((await del("/api/v1/job-schedules/9999", admin)).statusCode).toBe(404);

    const sched = await createSchedule(admin);
    expect((await del(`/api/v1/job-schedules/${sched.id}`, admin)).statusCode).toBe(204);
    expect((await get(`/api/v1/job-schedules/${sched.id}`, admin)).statusCode).toBe(404);
  });
});

describe("调度器 tick", () => {
  it("到期调度 → 物化 trigger='scheduled' 队列行并推进 nextRunAt / 记 lastRunAt", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin, { cron: "* * * * *" });
    const expectedNext = cronNext("* * * * *", clock.t);

    // 未到期：tick 不触发
    const scheduler = createJobScheduler({ db: tmp.db, now: () => clock.t });
    expect(scheduler.tick()).toBe(0);

    // 把 next_run_at 提前到 now，模拟到期
    tmp.sqlite.prepare("UPDATE job_schedules SET next_run_at = ? WHERE id = ?").run(clock.t, sched.id);
    expect(scheduler.tick()).toBe(1);

    const job = tmp.sqlite
      .prepare("SELECT id, trigger, trigger_spec, status FROM background_jobs WHERE trigger='scheduled'")
      .get() as { id: number; trigger: string; trigger_spec: string; status: string };
    expect(job.trigger).toBe("scheduled");
    expect(job.trigger_spec).toBe("* * * * *");
    expect(job.status).toBe("queued");

    const row = tmp.sqlite.prepare("SELECT last_run_at, next_run_at FROM job_schedules WHERE id = ?").get(sched.id) as { last_run_at: number; next_run_at: number };
    expect(row.last_run_at).toBe(clock.t);
    expect(row.next_run_at).toBe(expectedNext); // cronNext(cron, now()) — 推进到当前时刻之后
  });

  it("CAS 防重复：同一 nextRunAt 只触发一次，tick 返回后不再命中", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin, { cron: "* * * * *" });
    // 直接插两条 due 调度（一颗提前到 now），验证各自推进、不重复
    tmp.sqlite.prepare("UPDATE job_schedules SET next_run_at = ? WHERE id = ?").run(clock.t - 60_000, sched.id);

    const scheduler = createJobScheduler({ db: tmp.db, now: () => clock.t });
    scheduler.tick();
    const count = tmp.sqlite.prepare("SELECT COUNT(*) c FROM background_jobs WHERE trigger='scheduled'").get() as { c: number };
    expect(count.c).toBe(1);
    // 再次 tick：next_run_at 已推进到未来 → 不再触发
    scheduler.tick();
    const after = tmp.sqlite.prepare("SELECT COUNT(*) c FROM background_jobs WHERE trigger='scheduled'").get() as { c: number };
    expect(after.c).toBe(1);
  });

  it("disable / 未到期调度不触发", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin, { cron: "* * * * *" });
    const off = await patch(`/api/v1/job-schedules/${sched.id}`, admin, { enabled: false });
    expect(off.json().data.nextRunAt).toBeNull();

    const scheduler = createJobScheduler({ db: tmp.db, now: () => clock.t });
    expect(scheduler.tick()).toBe(0);
  });
});

describe("立即调度一次（POST /:id/run）", () => {
  it("入队 trigger='scheduled' 且 createdBy=admin，不推进 nextRunAt；不存在 → 404", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const sched = await createSchedule(admin, { cron: "* * * * *" });
    const before = tmp.sqlite.prepare("SELECT next_run_at FROM job_schedules WHERE id = ?").get(sched.id) as { next_run_at: number };

    const res = await post(`/api/v1/job-schedules/${sched.id}/run`, admin, {});
    expect(res.statusCode).toBe(200);
    const job = res.json().data;
    expect(job.trigger).toBe("scheduled");
    expect(job.triggerSpec).toBe("* * * * *");
    expect(job.createdBy).toEqual({ id: 1, nickname: "昵称-admin" });

    const after = tmp.sqlite.prepare("SELECT next_run_at FROM job_schedules WHERE id = ?").get(sched.id) as { next_run_at: number };
    expect(after.next_run_at).toBe(before.next_run_at); // 不推进

    expect((await post("/api/v1/job-schedules/9999/run", admin, {})).statusCode).toBe(404);
  });
});

describe("与执行器集成", () => {
  it("tick 生成的任务可被 pumpOnce 消费到终态", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await post("/api/v1/customers", cookie, { nickname: "定时任务客户" });
    await createSchedule(cookie, { cron: "* * * * *" });
    tmp.sqlite.prepare("UPDATE job_schedules SET next_run_at = ?").run(clock.t);

    const scheduler = createJobScheduler({ db: tmp.db, now: () => clock.t });
    scheduler.tick();

    const runner = createJobRunner({
      db: tmp.db,
      now: () => clock.t,
      fetchFn: vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ identity: [], stage: [], interest: [] }) } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ) as unknown as typeof fetch,
    });
    const claimed = await runner.pumpOnce();
    expect(claimed?.trigger).toBe("scheduled");
    const row = tmp.sqlite.prepare("SELECT status FROM background_jobs WHERE trigger='scheduled'").get() as { status: string };
    expect(row.status).toBe("succeeded");
  });
});
