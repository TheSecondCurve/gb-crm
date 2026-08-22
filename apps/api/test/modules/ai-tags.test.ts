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

describe("AI 打标扩展：行业写回 + 自建新标签", () => {
  it("行业：非空 → 写入并覆盖已有值（总是覆盖）；空串/缺失 → 不动", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();

    // 首次无行业：trim 后写入
    const app1 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({ identity: [], stage: [], interest: [], industry: " 教育 " }),
    });
    try {
      const r1 = await app1.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().data.industry).toBe("教育");
    } finally {
      await app1.close();
    }

    // 已有「教育」→ 再生成「金融」→ 总是覆盖
    const app2 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({ identity: [], stage: [], interest: [], industry: "金融" }),
    });
    try {
      const r2 = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().data.industry).toBe("金融");
    } finally {
      await app2.close();
    }

    // 空串 → 不动（保留「金融」）
    const app3 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({ identity: [], stage: [], interest: [], industry: "" }),
    });
    try {
      const r3 = await app3.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(r3.statusCode).toBe(200);
      expect(r3.json().data.industry).toBe("金融");
    } finally {
      await app3.close();
    }

    // 缺失键 → 不动
    const app4 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({ identity: [], stage: [], interest: [] }),
    });
    try {
      const r4 = await app4.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(r4.statusCode).toBe(200);
      expect(r4.json().data.industry).toBe("金融");
    } finally {
      await app4.close();
    }
  });

  it("新标签自建：入词表（enabled=1、sort=max+1、scope 正确、审计列），客户标签含新 id", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();
    const beforeMax = (tmp.sqlite.prepare("SELECT COALESCE(MAX(sort), 0) v FROM tags").get() as { v: number }).v;

    const app2 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({
        identity: [], stage: [], interest: [],
        newTags: [
          { name: "内容创业者", scope: "identity" },
          { name: "本地生活", scope: "interest" },
        ],
      }),
    });
    try {
      const res = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const names = res.json().data.tags.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(["内容创业者", "本地生活"]));
    } finally {
      await app2.close();
    }

    const rows = tmp.sqlite.prepare(
      "SELECT id, name, scope, sort, enabled, created_by FROM tags WHERE deleted_at IS NULL AND name IN ('内容创业者','本地生活')",
    ).all() as { id: number; name: string; scope: string; sort: number; enabled: number; created_by: number }[];
    expect(rows).toHaveLength(2);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r])) as Record<string, { id: number; name: string; scope: string; sort: number; enabled: number; created_by: number }>;
    expect(byName["内容创业者"]).toMatchObject({ scope: "identity", enabled: 1, created_by: 1 });
    expect(byName["本地生活"]).toMatchObject({ scope: "interest", enabled: 1 });
    expect(byName["内容创业者"]!.sort).toBe(beforeMax + 1); // 依次 max+1
    expect(byName["本地生活"]!.sort).toBe(beforeMax + 2);

    const customerTagIds = (tmp.sqlite.prepare("SELECT tag_id FROM customer_tags WHERE customer_id = ?").all(id) as { tag_id: number }[]).map((r) => r.tag_id);
    expect(customerTagIds).toEqual(expect.arrayContaining([byName["内容创业者"]!.id, byName["本地生活"]!.id]));
  });

  it("新标签复用去重：词表已有同名 live 标签 → 复用其 id 不新建；再次运行行数不变", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();
    const existing = (tmp.sqlite.prepare("SELECT id FROM tags WHERE name = '创业者'").get() as { id: number }).id;
    const countBefore = (tmp.sqlite.prepare("SELECT COUNT(*) c FROM tags WHERE deleted_at IS NULL").get() as { c: number }).c;

    const app2 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({
        identity: [], stage: [], interest: [],
        newTags: [{ name: "创业者", scope: "identity" }],
      }),
    });
    try {
      const r1 = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(r1.statusCode).toBe(200);
      const ids1 = (tmp.sqlite.prepare("SELECT tag_id FROM customer_tags WHERE customer_id = ?").all(id) as { tag_id: number }[]).map((r) => r.tag_id);
      expect(ids1).toContain(existing);

      const r2 = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(r2.statusCode).toBe(200);
      const countAfter = (tmp.sqlite.prepare("SELECT COUNT(*) c FROM tags WHERE deleted_at IS NULL").get() as { c: number }).c;
      expect(countAfter).toBe(countBefore);
    } finally {
      await app2.close();
    }
  });

  it("预算上限：返回 3 个新标签 → 只建 2 个，第 3 个丢弃", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();
    const app2 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({
        identity: [], stage: [], interest: [],
        newTags: [
          { name: "新甲", scope: "identity" },
          { name: "新乙", scope: "interest" },
          { name: "新丙", scope: "other" },
        ],
      }),
    });
    try {
      const res = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const names = res.json().data.tags.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(["新甲", "新乙"]));
      expect(names).not.toContain("新丙");
      const created = (tmp.sqlite.prepare("SELECT COUNT(*) c FROM tags WHERE name IN ('新甲','新乙','新丙')").get() as { c: number }).c;
      expect(created).toBe(2);
    } finally {
      await app2.close();
    }
  });

  it("非法输入：空名 / 非四枚举 scope / 非字符串 name → 丢弃不建", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();
    const countBefore = (tmp.sqlite.prepare("SELECT COUNT(*) c FROM tags WHERE deleted_at IS NULL").get() as { c: number }).c;
    const app2 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({
        identity: [], stage: [], interest: [],
        newTags: [
          { name: "   ", scope: "identity" }, // 空名
          { name: "合法名", scope: "不存在的scope" }, // 非法 scope
          { name: 123, scope: "identity" }, // 非字符串 name
          { name: null, scope: "identity" },
        ],
      }),
    });
    try {
      const res = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const countAfter = (tmp.sqlite.prepare("SELECT COUNT(*) c FROM tags WHERE deleted_at IS NULL").get() as { c: number }).c;
      expect(countAfter).toBe(countBefore);
    } finally {
      await app2.close();
    }
  });

  it("既选词表又新建：identity 词表内标签 + newTags → 并集正确", async () => {
    seedAiConfigRow();
    const { id, cookie } = await createCustomerAsAdmin();
    const app2 = buildApp({
      env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0,
      llmFetch: llmOk({
        identity: ["创业者"], stage: [], interest: [],
        newTags: [{ name: "新词A", scope: "identity" }],
      }),
    });
    try {
      const res = await app2.inject({ method: "POST", url: `/api/v1/customers/${id}/tags/generate`, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const names = res.json().data.tags.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(["创业者", "新词A"]));
    } finally {
      await app2.close();
    }
  });
});
