// AI 打标（K46）：未配置 422；mock llmFetch 正常生成（并集合并、未知丢弃）；LLM 失败 502；RBAC。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { systemConfigs } from "../../src/db/schema.js";
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
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });

/** 直接种 system_configs code='llm'（绕过 API，等价于设置页已保存，K50） */
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

function llmFailing(status: number): typeof fetch {
  return vi.fn(async () => new Response("upstream boom", { status })) as unknown as typeof fetch;
}

async function createCustomerAsAdmin(): Promise<{ id: number; cookie: string; updatedAt: number }> {
  const cookie = await loginAsRole("admin");
  const res = await post("/api/v1/customers", cookie, { nickname: "AI 客户" });
  expect(res.statusCode).toBe(201);
  const data = res.json().data;
  return { id: data.id, cookie, updatedAt: data.updatedAt };
}

describe("AI 打标端点（K46）", () => {
  it("未配置 ai_config → 422 中文提示", async () => {
    const { id, cookie } = await createCustomerAsAdmin();
    const res = await post(`/api/v1/customers/${id}/tags/generate`, cookie);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("系统设置");
  });

  it("正常生成：词表内名称写入、未知丢弃、与原标签取并集；touch updatedAt", async () => {
    seedAiConfigRow();
    const { id, cookie, updatedAt } = await createCustomerAsAdmin();
    const t1 = tmp.sqlite.prepare("SELECT id FROM tags WHERE name = ?").get("已联系") as {
      id: number;
    };

    // 先手动打一个标签（验证并集：AI 结果不覆盖它）
    clock.t += 1000;
    const patchRes = await patch(`/api/v1/customers/${id}`, cookie, {
      tagIds: [t1.id],
      updatedAt,
    });
    expect(patchRes.statusCode).toBe(200);
    const manualUpdatedAt = patchRes.json().data.updatedAt;

    // mock LLM：返回词表内 3 个 + 1 个未知标签
    const mockFetch = llmOk({
      identity: ["创业者", "不存在的身份"],
      stage: ["已成交"],
      interest: ["商学院", "虚拟兴趣"],
    });
    const app2 = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
      llmFetch: mockFetch,
    });
    try {
      clock.t += 1000;
      const res = await app2.inject({
        method: "POST",
        url: `/api/v1/customers/${id}/tags/generate`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const names = res.json().data.tags.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(["已联系", "创业者", "已成交", "商学院"]));
      expect(names).not.toContain("不存在的身份");
      expect(names).not.toContain("虚拟兴趣");
      // 并集合并后 updatedAt 已 touch（> manualUpdatedAt）
      expect(res.json().data.updatedAt).toBeGreaterThan(manualUpdatedAt);
    } finally {
      await app2.close();
    }
  });

  it("LLM 上游错误 → 502 LLM_ERROR；不可解析内容 → 502 LLM_ERROR", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();

    const failing = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
      llmFetch: llmFailing(500),
    });
    try {
      const r1 = await failing.inject({
        method: "POST",
        url: `/api/v1/customers/${id}/tags/generate`,
        headers: { cookie },
      });
      expect(r1.statusCode).toBe(502);
      expect(r1.json().error.code).toBe("LLM_ERROR");
    } finally {
      await failing.close();
    }

    const badJson = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
      llmFetch: llmOk("我什么都不会输出"),
    });
    try {
      const r2 = await badJson.inject({
        method: "POST",
        url: `/api/v1/customers/${id}/tags/generate`,
        headers: { cookie },
      });
      expect(r2.statusCode).toBe(502);
      expect(r2.json().error.code).toBe("LLM_ERROR");
    } finally {
      await badJson.close();
    }
  });

  it("assistant 可调用（customers.update 同权）；不存在客户 → 404；未登录 401", async () => {
    seedAiConfigRow();
    const { id } = await createCustomerAsAdmin();
    const asstCookie = await loginAsRole("assistant");
    const mockFetch = llmOk({ identity: [], stage: [], interest: [] });
    const app2 = buildApp({
      env: testEnv(),
      db: tmp.db,
      now: () => clock.t,
      gcProbability: 0,
      llmFetch: mockFetch,
    });
    try {
      const ok = await app2.inject({
        method: "POST",
        url: `/api/v1/customers/${id}/tags/generate`,
        headers: { cookie: asstCookie },
      });
      expect(ok.statusCode).toBe(200);

      expect((await post(`/api/v1/customers/9999/tags/generate`, asstCookie)).statusCode).toBe(404);
    } finally {
      await app2.close();
    }
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate` })).statusCode,
    ).toBe(401);
  });
});
