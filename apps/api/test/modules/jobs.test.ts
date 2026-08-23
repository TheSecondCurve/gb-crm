// K51 后台任务（background-jobs）：创建/预检/列表/详情/取消 + 执行器 pumpOnce 状态流转 + 恢复 + 取消感知。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { systemConfigs } from "../../src/db/schema.js";
import { runBulkTaggingJob } from "../../src/modules/customers/service.js";
import { JOB_TYPES } from "../../src/modules/jobs/registry.js";
import { createJobRunner } from "../../src/modules/jobs/runner.js";
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

async function loginAsRole(role: "admin" | "operator" | "assistant") {
  const username = `u-${role}`;
  await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  return loginAs(app, username, "password123");
}

type JsonBody = Record<string, unknown>;
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

function seedAiConfigRow(baseUrl = "https://llm.example/v1", apiKey = "sk-test-key", model = "m1"): void {
  tmp.db
    .insert(systemConfigs)
    .values({
      code: "llm",
      value: JSON.stringify({ provider: "test", baseUrl, apiKey, model }),
      updatedAt: clock.t,
      updatedBy: null,
    })
    .onConflictDoNothing()
    .run();
}

function llmOk(payload: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

/** 对命中 nickname 的请求返回上游错误，其余返回 payload 的 LLM mock */
function llmConditional(payload: unknown, failForNickname: string): typeof fetch {
  return vi.fn(async (_url, init) => {
    const body = String(init?.body ?? "");
    if (body.includes(failForNickname)) {
      return new Response("upstream boom", { status: 500 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

async function createCustomer(
  cookie: string,
  nickname: string,
): Promise<{ id: number; updatedAt: number }> {
  const res = await post("/api/v1/customers", cookie, { nickname });
  expect(res.statusCode).toBe(201);
  return { id: res.json().data.id, updatedAt: res.json().data.updatedAt };
}

async function createJob(cookie: string, type = "customer-tags-generate-all", params: JsonBody = {}) {
  const res = await post("/api/v1/background-jobs", cookie, { type, params });
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: number; status: string };
}

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

describe("创建任务", () => {
  it("未登录 401；三种角色均可创建；未知 type → 422", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const operator = await loginAsRole("operator");
    const assistant = await loginAsRole("assistant");
    for (const cookie of [admin, operator, assistant]) {
      expect((await post("/api/v1/background-jobs", cookie, { type: "customer-tags-generate-all", params: {} })).statusCode).toBe(201);
    }
    expect(
      (await post("/api/v1/background-jobs", admin, { type: "nope", params: {} })).statusCode,
    ).toBe(422);
    expect((await post("/api/v1/background-jobs", admin, { type: "customer-tags-generate-all", params: { q: "关键词" } })).statusCode).toBe(201); // 合法筛选参数直接入队（非法 params 见「任务参数校验」）
    expect((await app.inject({ method: "POST", url: "/api/v1/background-jobs", payload: { type: "customer-tags-generate-all" } })).statusCode).toBe(401);
  });

  it("LLM 未配置 / 词表为空 → 创建即 422（预检）", async () => {
    const admin = await loginAsRole("admin");
    const unconfigured = await post("/api/v1/background-jobs", admin, { type: "customer-tags-generate-all", params: {} });
    expect(unconfigured.statusCode).toBe(422);
    expect(unconfigured.json().error.message).toContain("系统设置");

    seedAiConfigRow();
    tmp.sqlite.prepare("UPDATE tags SET deleted_at = ?").run(clock.t);
    const emptyVocab = await post("/api/v1/background-jobs", admin, { type: "customer-tags-generate-all", params: {} });
    expect(emptyVocab.statusCode).toBe(422);
    expect(emptyVocab.json().error.message).toContain("业务设置");
  });
});

describe("执行器（pumpOnce）", () => {
  it("全成功 → succeeded：progress/result 正确、客户已打标、startedAt/finishedAt 落库", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    const a = await createCustomer(cookie, "任务客户 A");
    const b = await createCustomer(cookie, "任务客户 B");
    const job = await createJob(cookie, "customer-tags-generate-all", {});

    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmOk({ identity: ["创业者"], stage: [], interest: [] }) });
    const claimed = await runner.pumpOnce();
    expect(claimed?.id).toBe(job.id);

    const res = await get(`/api/v1/background-jobs/${job.id}`, cookie);
    const dto = res.json().data;
    expect(dto.status).toBe("succeeded");
    expect(dto.typeLabel).toBe("全量生成客户标签");
    expect(dto.progress).toEqual({ processed: 2, total: 2, succeeded: 2, failed: 0 });
    expect(dto.result).toMatchObject({ total: 2, succeeded: 2, failed: 0, cancelled: false });
    expect(dto.result.failures).toEqual([]);
    expect(dto.startedAt).toBe(clock.t);
    expect(dto.finishedAt).toBe(clock.t);
    expect(dto.createdBy).toEqual({ id: 1, nickname: "昵称-admin" });

    const genTag = (tmp.sqlite.prepare("SELECT id FROM tags WHERE name = '创业者'").get() as { id: number }).id;
    const ids = tmp.sqlite.prepare("SELECT customer_id FROM customer_tags WHERE tag_id = ?").all(genTag) as { customer_id: number }[];
    expect(ids.map((r) => r.customer_id).sort()).toEqual([a.id, b.id].sort());
  });

  it("部分失败 → partial：失败明细写入 result，失败客户标签不动、成功客户已打标", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    const a = await createCustomer(cookie, "任务客户 A");
    const b = await createCustomer(cookie, "任务客户 B");
    const c = await createCustomer(cookie, "任务客户 C");

    // B 先手动打一个标签（验证失败后原标签保留）
    const manualTag = (tmp.sqlite.prepare("SELECT id FROM tags WHERE name = '已联系'").get() as { id: number }).id;
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/customers/${b.id}`,
      headers: { cookie },
      payload: { tagIds: [manualTag], updatedAt: b.updatedAt },
    });
    expect(patchRes.statusCode).toBe(200);

    const job = await createJob(cookie, "customer-tags-generate-all", {});
    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmConditional({ identity: ["创业者"], stage: [], interest: [] }, "任务客户 B") });
    await runner.pumpOnce();

    const dto = (await get(`/api/v1/background-jobs/${job.id}`, cookie)).json().data;
    expect(dto.status).toBe("partial");
    expect(dto.progress).toEqual({ processed: 3, total: 3, succeeded: 2, failed: 1 });
    expect(dto.result.failures).toHaveLength(1);
    expect(dto.result.failures[0]).toMatchObject({ customerId: b.id, nickname: "任务客户 B" });

    const tagIds = (customerId: number) =>
      (tmp.sqlite.prepare("SELECT tag_id FROM customer_tags WHERE customer_id = ?").all(customerId) as { tag_id: number }[]).map((r) => r.tag_id);
    const genTag = (tmp.sqlite.prepare("SELECT id FROM tags WHERE name = '创业者'").get() as { id: number }).id;
    expect(tagIds(a.id)).toContain(genTag); // 成功客户已打标
    expect(tagIds(c.id)).toContain(genTag);
    expect(tagIds(b.id)).toEqual([manualTag]); // 失败客户原标签保留、未被写入新标签
  });

  it("全失败 → failed", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await createCustomer(cookie, "任务客户 A");
    const job = await createJob(cookie, "customer-tags-generate-all", {});
    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmConditional({ identity: [] }, "任务客户 A") });
    await runner.pumpOnce();
    const dto = (await get(`/api/v1/background-jobs/${job.id}`, cookie)).json().data;
    expect(dto.status).toBe("failed");
    expect(dto.progress).toEqual({ processed: 1, total: 1, succeeded: 0, failed: 1 });
  });

  it("未知 type → failed（error=未知任务类型）", async () => {
    const cookie = await loginAsRole("admin");
    const res = await post("/api/v1/background-jobs", cookie, { type: "nope", params: {} });
    expect(res.statusCode).toBe(422);
    // 绕过创建校验直接插行，验证执行器兜底
    tmp.sqlite
      .prepare("INSERT INTO background_jobs (type, params, status, progress, trigger, created_at, created_by) VALUES ('nope','{}','queued','{}','manual',?,?)")
      .run(clock.t, 1);
    const runner = createJobRunner({ db: tmp.db, now: () => clock.t });
    const claimed = await runner.pumpOnce();
    expect(claimed?.type).toBe("nope");
    const row = tmp.sqlite.prepare("SELECT status, error FROM background_jobs WHERE id = ?").get(claimed?.id) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("未知任务类型");
  });

  it("取消感知：isCancelled 为真时 handler 以 cancelled 结束且不发 LLM", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await createCustomer(cookie, "取消客户 A");
    const mockFetch = llmOk({ identity: ["创业者"], stage: [], interest: [] });

    const finished: { status?: string; result?: unknown } = {};
    const ctx = {
      db: tmp.db,
      jobId: 1,
      audit: { now: clock.t, userId: 1 },
      fetchFn: mockFetch,
      isCancelled: () => true,
      reportProgress: () => {},
      finish: (status: string, payload: { result?: unknown }) => {
        finished.status = status;
        finished.result = payload.result;
      },
    };
    await JOB_TYPES["customer-tags-generate-all"]!.run(ctx as never, {});
    expect(finished.status).toBe("cancelled");
    expect((finished.result as { cancelled: boolean })?.cancelled).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("runBulkTaggingJob 中途取消：已处理保留、返回 cancelled=true", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await createCustomer(cookie, "中途取消 A");
    await createCustomer(cookie, "中途取消 B");

    let n = 0;
    const mockFetch = llmOk({ identity: ["创业者"], stage: [], interest: [] });
    const result = await runBulkTaggingJob(
      tmp.db,
      {},
      { now: clock.t, userId: 1 },
      { fetchFn: mockFetch, isCancelled: () => ++n > 1, onProgress: () => {} },
    );
    expect(result.cancelled).toBe(true);
    expect(result.succeeded).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("runBulkTaggingJob 新标签预算：跨客户累计，超预算的新标签丢弃", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await createCustomer(cookie, "批量新标签 A");
    await createCustomer(cookie, "批量新标签 B");
    await createCustomer(cookie, "批量新标签 C");

    // 每个客户返回 2 个互不相同的新标签（共 6 个唯一名）；注入预算 max=4 → 只建 4 个
    let n = 0;
    const mockFetch = vi.fn(async () => {
      n += 1;
      const payload = {
        identity: [],
        stage: [],
        interest: [],
        newTags: [
          { name: `批量新${n}-甲`, scope: "identity" },
          { name: `批量新${n}-乙`, scope: "interest" },
        ],
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await runBulkTaggingJob(
      tmp.db,
      {},
      { now: clock.t, userId: 1 },
      { fetchFn: mockFetch, newTagBudget: { used: 0, max: 4 } },
    );
    expect(result.succeeded).toBe(3);

    const created = (tmp.sqlite.prepare("SELECT COUNT(*) c FROM tags WHERE name LIKE '批量新%'").get() as { c: number }).c;
    expect(created).toBe(4); // 预算 4：前两个被处理客户各建 2 个，最后一个客户预算耗尽全丢

    // 新标签落库总量 = 4，且分布在 2 个客户上（每客户 2 个），剩余 1 个客户不落任何新标签
    const links = tmp.sqlite.prepare(
      "SELECT customer_id, COUNT(*) c FROM customer_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE '批量新%') GROUP BY customer_id",
    ).all() as { customer_id: number; c: number }[];
    expect(links).toHaveLength(2);
    expect(links.every((r) => r.c === 2)).toBe(true);
  });
});

describe("取消任务", () => {
  it("本人可取消 queued；取消后执行器不再领取", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    const job = await createJob(cookie);
    const res = await post(`/api/v1/background-jobs/${job.id}/cancel`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("cancelled");

    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmOk({}) });
    expect(await runner.pumpOnce()).toBeNull();
  });

  it("running 中可取消（模拟执行器已领取）；结束态（succeeded）取消 → 409", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    const job = await createJob(cookie);
    tmp.sqlite.prepare("UPDATE background_jobs SET status='running', started_at=? WHERE id=?").run(clock.t, job.id);
    expect((await post(`/api/v1/background-jobs/${job.id}/cancel`, cookie)).statusCode).toBe(200);

    const job2 = await createJob(cookie);
    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmOk({ identity: [], stage: [], interest: [] }) });
    await runner.pumpOnce();
    const cancelRes = await post(`/api/v1/background-jobs/${job2.id}/cancel`, cookie);
    expect(cancelRes.statusCode).toBe(409);
    expect(cancelRes.json().error.code).toBe("CONFLICT");
  });

  it("他人取消 → 403；admin cancelAny 可取消他人任务", async () => {
    seedAiConfigRow();
    const operator = await loginAsRole("operator");
    const job = await createJob(operator);
    const assistant = await loginAsRole("assistant");
    expect((await post(`/api/v1/background-jobs/${job.id}/cancel`, assistant)).statusCode).toBe(403);

    const admin = await loginAsRole("admin");
    expect((await post(`/api/v1/background-jobs/${job.id}/cancel`, admin)).statusCode).toBe(200);
  });
});

describe("取消终态不可覆盖（H3）", () => {
  const CANCEL_SQL =
    "UPDATE background_jobs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('queued','running')";
  const rowOf = (id: number) =>
    tmp.sqlite.prepare("SELECT status, error, finished_at FROM background_jobs WHERE id = ?").get(id) as {
      status: string;
      error: string | null;
      finished_at: number;
    };

  afterEach(() => {
    delete JOB_TYPES["test-cancel-boom"];
  });

  it("最后一个客户的 LLM await 窗口内被取消：循环走完仍保持 cancelled，finishedAt 不被改写", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await createCustomer(cookie, "尾窗取消客户");
    const job = await createJob(cookie);
    clock.t += 1;
    const cancelledAt = clock.t;

    // fetch 触发时才取消：模拟取消落在最后一次 isCancelled 检查之后的 LLM await 窗口内
    const runner = createJobRunner({
      db: tmp.db,
      now: () => clock.t,
      fetchFn: vi.fn(async () => {
        tmp.sqlite.prepare(CANCEL_SQL).run(cancelledAt, job.id);
        clock.t += 60_000; // 若终态被正常收尾覆盖，finished_at 会变成更大的值而暴露
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });
    await runner.pumpOnce();

    expect(rowOf(job.id)).toEqual({ status: "cancelled", error: null, finished_at: cancelledAt });
  });

  it("兜底 failed 不覆盖 cancelled（handler 取消后抛错 / 未 finish）", async () => {
    const admin = await loginAsRole("admin");
    expect(admin).toBeTruthy();
    clock.t += 1;
    const cancelledAt = clock.t;
    JOB_TYPES["test-cancel-boom"] = {
      label: "测试-取消后抛错",
      requiredPermission: { resource: "customers", action: "update" },
      run: async (ctx) => {
        tmp.sqlite.prepare(CANCEL_SQL).run(cancelledAt, ctx.jobId);
        throw new Error("boom");
      },
    };
    const jobId = Number(
      tmp.sqlite
        .prepare("INSERT INTO background_jobs (type, params, status, progress, trigger, created_at, created_by) VALUES ('test-cancel-boom','{}','queued','{}','manual',?,1)")
        .run(clock.t).lastInsertRowid,
    );

    const runner = createJobRunner({ db: tmp.db, now: () => clock.t });
    await runner.pumpOnce(); // catch 兜底 + 未 finish 兜底都不得覆盖 cancelled

    expect(rowOf(jobId)).toEqual({ status: "cancelled", error: null, finished_at: cancelledAt });
  });
});

describe("任务参数校验（M11）", () => {
  it("非法 params → 创建 422 VALIDATION（q 类型错 / sort 非法枚举 / 未知键 / 分页键）", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    for (const params of [{ q: 123 }, { sort: "x" }, { foo: 1 }, { page: 2 }]) {
      const res = await post("/api/v1/background-jobs", cookie, { type: "customer-tags-generate-all", params });
      expect(res.statusCode, JSON.stringify(params)).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION");
      expect(typeof res.json().error.message).toBe("string");
    }
  });

  it("合法筛选参数创建成功并按筛选执行（不回归）", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    const hit = await createCustomer(cookie, "筛选命中客户");
    await createCustomer(cookie, "其它客户甲");
    const job = await createJob(cookie, "customer-tags-generate-all", { q: "筛选命中" });

    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmOk({ identity: ["创业者"], stage: [], interest: [] }) });
    await runner.pumpOnce();

    const dto = (await get(`/api/v1/background-jobs/${job.id}`, cookie)).json().data;
    expect(dto.status).toBe("succeeded");
    expect(dto.progress).toEqual({ processed: 1, total: 1, succeeded: 1, failed: 0 });
    const genTag = (tmp.sqlite.prepare("SELECT id FROM tags WHERE name = '创业者'").get() as { id: number }).id;
    const linked = tmp.sqlite.prepare("SELECT customer_id FROM customer_tags WHERE tag_id = ?").all(genTag) as { customer_id: number }[];
    expect(linked.map((r) => r.customer_id)).toEqual([hit.id]);
  });

  it("执行侧复验：历史脏 params 执行 → failed 且中文提示（不再裸 cast 进 SQL）", async () => {
    seedAiConfigRow();
    await loginAsRole("admin"); // 种子用户 id=1，满足 created_by 外键
    tmp.sqlite
      .prepare("INSERT INTO background_jobs (type, params, status, progress, trigger, created_at, created_by) VALUES ('customer-tags-generate-all','{\"q\":123}','queued','{}','manual',?,1)")
      .run(clock.t);

    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmOk({ identity: [], stage: [], interest: [] }) });
    await runner.pumpOnce();

    const row = tmp.sqlite.prepare("SELECT status, error FROM background_jobs WHERE type = 'customer-tags-generate-all'").get() as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("参数不合法");
  });
});

describe("重启恢复与列表", () => {
  it("recover()：残留 running → failed（重启中断文案）", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    const job = await createJob(cookie);
    tmp.sqlite.prepare("UPDATE background_jobs SET status='running', started_at=? WHERE id=?").run(clock.t, job.id);

    const runner = createJobRunner({ db: tmp.db, now: () => clock.t });
    runner.recover();
    const row = tmp.sqlite.prepare("SELECT status, error FROM background_jobs WHERE id = ?").get(job.id) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("服务重启");
  });

  it("列表：分页 meta + status 过滤；详情 404", async () => {
    seedAiConfigRow();
    const cookie = await loginAsRole("admin");
    await createJob(cookie);
    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: llmOk({ identity: [], stage: [], interest: [] }) });
    await runner.pumpOnce(); // 一个 succeeded

    const all = await get("/api/v1/background-jobs", cookie);
    expect(all.json().meta).toMatchObject({ page: 1, pageSize: 25, total: 1 });
    expect(all.json().data).toHaveLength(1);

    const filtered = await get("/api/v1/background-jobs?status=running", cookie);
    expect(filtered.json().meta.total).toBe(0);

    expect((await get("/api/v1/background-jobs/9999", cookie)).statusCode).toBe(404);
  });
});
