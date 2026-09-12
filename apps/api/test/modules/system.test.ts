// system ai-config（K46）：GET 掩码返回；PATCH 单管理员；apiKey 空/缺席保留旧值。
import { canAllowedPageKeys } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
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

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });

describe("GET /api/v1/system/ai-config", () => {
  it("未配置 → 默认空值 + apiKeySet=false；未登录 401", async () => {
    const cookie = await loginAsRole("admin");
    const res = await get("/api/v1/system/ai-config", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      provider: null,
      baseUrl: null,
      model: null,
      apiKeySet: false,
      apiKeyMasked: null,
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/system/ai-config" })).statusCode).toBe(
      401,
    );
  });

  it("operator/assistant → 403（system 仅 admin，K46）", async () => {
    for (const role of ["operator", "assistant"] as const) {
      const cookie = await loginAsRole(role);
      expect((await get("/api/v1/system/ai-config", cookie)).statusCode).toBe(403);
      expect(
        (await patch("/api/v1/system/ai-config", cookie, { baseUrl: "x" })).statusCode,
      ).toBe(403);
    }
  });
});

describe("PATCH /api/v1/system/ai-config", () => {
  it("保存配置；GET 只回掩码（永远不全量返回 key）", async () => {
    const cookie = await loginAsRole("admin");
    const res = await patch("/api/v1/system/ai-config", cookie, {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-abcdefgh12345678",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKeySet: true,
      apiKeyMasked: "sk-a…5678",
    });
    // 响应与 GET 均不包含完整 key
    expect(res.body).not.toContain("sk-abcdefgh12345678");

    const again = await get("/api/v1/system/ai-config", cookie);
    expect(again.body).not.toContain("sk-abcdefgh12345678");
  });

  it("apiKey 缺席/空 → 保留旧值；可只改单项", async () => {
    const cookie = await loginAsRole("admin");
    await patch("/api/v1/system/ai-config", cookie, {
      baseUrl: "https://a.example/v1",
      model: "m1",
      apiKey: "secret-key-1",
    });

    const r2 = await patch("/api/v1/system/ai-config", cookie, { model: "m2" });
    expect(r2.json().data.model).toBe("m2");
    expect(r2.json().data.apiKeySet).toBe(true);

    const r3 = await patch("/api/v1/system/ai-config", cookie, {
      baseUrl: null,
      model: null,
    });
    expect(r3.json().data.baseUrl).toBeNull();
    expect(r3.json().data.model).toBeNull();
    expect(r3.json().data.apiKeySet).toBe(true); // key 未被清
  });

  it("body 非对象/字段非法 → 422", async () => {
    const cookie = await loginAsRole("admin");
    expect((await patch("/api/v1/system/ai-config", cookie, { model: 123 })).statusCode).toBe(422);
  });
});

describe("文案工作台 system prompt（GET/PATCH /api/v1/system/copywriting-prompts）", () => {
  const URL = "/api/v1/system/copywriting-prompts";

  it("未配置 → 内置默认（含女商红线，customized=false，updatedAt=null）；未登录 401；operator/assistant 403", async () => {
    expect((await app.inject({ method: "GET", url: URL })).statusCode).toBe(401);
    for (const role of ["operator", "assistant"] as const) {
      const cookie = await loginAsRole(role);
      expect((await get(URL, cookie)).statusCode).toBe(403);
      expect((await patch(URL, cookie, { generateSystemPrompt: "x" })).statusCode).toBe(403);
    }

    const cookie = await loginAsRole("admin");
    const res = await get(URL, cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.generateSystemPrompt).toContain("闪光少女斯斯");
    expect(data.generateSystemPrompt).toContain("待核");
    expect(data.auditSystemPrompt).toContain("审计");
    expect(data.customized).toBe(false);
    expect(data.updatedAt).toBeNull();
    expect(data.updatedBy).toBeNull();
  });

  it("PATCH 自定义 → GET 回自定义且记审计；PATCH null 单项恢复默认、另一项保留", async () => {
    const cookie = await loginAsRole("admin");
    const r1 = await patch(URL, cookie, {
      generateSystemPrompt: "自定义生成提示词",
      auditSystemPrompt: "自定义审计提示词",
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.generateSystemPrompt).toBe("自定义生成提示词");
    expect(r1.json().data.auditSystemPrompt).toBe("自定义审计提示词");
    expect(r1.json().data.customized).toBe(true);
    expect(r1.json().data.updatedAt).toBe(clock.t);
    expect(typeof r1.json().data.updatedBy).toBe("number");

    const r2 = await patch(URL, cookie, { generateSystemPrompt: null });
    expect(r2.json().data.generateSystemPrompt).toContain("闪光少女斯斯"); // 恢复内置默认
    expect(r2.json().data.auditSystemPrompt).toBe("自定义审计提示词"); // 另一项保留
    expect(r2.json().data.customized).toBe(true);

    const r3 = await patch(URL, cookie, { auditSystemPrompt: null });
    expect(r3.json().data.customized).toBe(false);
  });

  it("空串/纯空白视为恢复默认；超长或非字符串 → 422", async () => {
    const cookie = await loginAsRole("admin");
    await patch(URL, cookie, { generateSystemPrompt: "临时" });
    const blank = await patch(URL, cookie, { generateSystemPrompt: "   " });
    expect(blank.json().data.generateSystemPrompt).toContain("闪光少女斯斯");

    expect((await patch(URL, cookie, { generateSystemPrompt: "a".repeat(4001) })).statusCode).toBe(422);
    expect((await patch(URL, cookie, { auditSystemPrompt: 123 })).statusCode).toBe(422);
  });
});

describe("角色→页面权限（GET/PATCH /api/v1/system/page-access）", () => {
  it("未登录 401；operator/assistant → 403（仅 admin，K46 同 system）", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/system/page-access" })).statusCode).toBe(401);
    for (const role of ["operator", "assistant"] as const) {
      const cookie = await loginAsRole(role);
      expect((await get("/api/v1/system/page-access", cookie)).statusCode).toBe(403);
      expect(
        (await patch("/api/v1/system/page-access", cookie, { roles: { operator: [] } }))
          .statusCode,
      ).toBe(403);
    }
  });

  it("默认无配置：enabled = can() 允许集（不收缩）；assistant 不含 users", async () => {
    const cookie = await loginAsRole("admin");
    const res = await get("/api/v1/system/page-access", cookie);
    expect(res.statusCode).toBe(200);
    const roles = res.json().data.roles;
    expect(roles.operator).toEqual({
      allowed: canAllowedPageKeys("operator"),
      enabled: canAllowedPageKeys("operator"),
    });
    expect(roles.assistant).toEqual({
      allowed: canAllowedPageKeys("assistant"),
      enabled: canAllowedPageKeys("assistant"),
    });
    expect(roles.assistant.enabled).not.toContain("users");
  });

  it("PATCH 收缩 operator；缺失的 role 保持不变；/auth/me.pages 同步生效", async () => {
    const adminCookie = await loginAsRole("admin");
    const res = await patch("/api/v1/system/page-access", adminCookie, {
      roles: { operator: ["my-customers"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.roles.operator.enabled).toEqual(["my-customers"]);
    expect(res.json().data.roles.assistant.enabled).toEqual(canAllowedPageKeys("assistant"));

    const opCookie = await loginAsRole("operator");
    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: opCookie } });
    expect(me.json().data.pages).toEqual(["my-customers"]);
  });

  it("PATCH 越权（assistant 配 users，用户不在其 can() 允许集内）→ 422", async () => {
    const cookie = await loginAsRole("admin");
    const res = await patch("/api/v1/system/page-access", cookie, {
      roles: { assistant: ["users"] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });
});

describe("文案专用 LLM（GET/PATCH /api/v1/system/copywriting-llm + POST .../test）", () => {
  const URL = "/api/v1/system/copywriting-llm";
  const TEST = `${URL}/test`;

  type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

  const postJson = (url: string, cookie: string, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

  const llmOkFetch = (): FetchMock =>
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as FetchMock;

  const appWithFetch = (fetchFn: typeof fetch): FastifyInstance =>
    buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0, llmFetch: fetchFn });

  it("未配置 → 全 null + dedicatedReady=false；未登录 401；operator/assistant 403", async () => {
    expect((await app.inject({ method: "GET", url: URL })).statusCode).toBe(401);
    for (const role of ["operator", "assistant"] as const) {
      const cookie = await loginAsRole(role);
      expect((await get(URL, cookie)).statusCode).toBe(403);
      expect((await patch(URL, cookie, { baseUrl: "x" })).statusCode).toBe(403);
      expect((await postJson(TEST, cookie, {})).statusCode).toBe(403);
    }

    const cookie = await loginAsRole("admin");
    const res = await get(URL, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      provider: null,
      baseUrl: null,
      model: null,
      apiKeySet: false,
      apiKeyMasked: null,
      dedicatedReady: false,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("PATCH 设置 → GET 掩码 + dedicatedReady=true + 审计；apiKey 缺席保留旧值、null 显式清除", async () => {
    const cookie = await loginAsRole("admin");
    const r1 = await patch(URL, cookie, {
      provider: "deepseek",
      baseUrl: "https://copy.example/v1",
      model: "copy-model",
      apiKey: "sk-abcdefghijklmnop",
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.apiKeySet).toBe(true);
    expect(r1.json().data.apiKeyMasked).toBe("sk-a…mnop");
    expect(r1.json().data.dedicatedReady).toBe(true);
    expect(r1.json().data.updatedAt).toBe(clock.t);

    // 缺席 apiKey → 保留旧值（masked 不变）
    const r2 = await patch(URL, cookie, { model: "copy-model-2" });
    expect(r2.json().data.model).toBe("copy-model-2");
    expect(r2.json().data.apiKeyMasked).toBe("sk-a…mnop");

    // null 清除 → 不再 ready
    const r3 = await patch(URL, cookie, { apiKey: null });
    expect(r3.json().data.apiKeySet).toBe(false);
    expect(r3.json().data.apiKeyMasked).toBeNull();
    expect(r3.json().data.dedicatedReady).toBe(false);

    // 清空 baseUrl → 不完整 → ready=false
    const r4 = await patch(URL, cookie, { baseUrl: null });
    expect(r4.json().data.dedicatedReady).toBe(false);
  });

  it("test：无配置且无 body → 422；body 现值齐全 → 200（用表单现值，不必先保存）；上游 500 → 502", async () => {
    const cookie = await loginAsRole("admin");
    const missing = await postJson(TEST, cookie);
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toContain("文案专用 LLM");

    const fn = llmOkFetch();
    const app2 = appWithFetch(fn);
    try {
      const ok = await app2.inject({
        method: "POST",
        url: TEST,
        headers: { cookie },
        payload: { baseUrl: "https://copy.example/v1", model: "m", apiKey: "sk-x" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().data).toEqual({ ok: true });
      expect(String(fn.mock.calls[0]![0])).toContain("copy.example");
    } finally {
      await app2.close();
    }

    const fail = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as FetchMock;
    const app3 = appWithFetch(fail);
    try {
      const res = await app3.inject({
        method: "POST",
        url: TEST,
        headers: { cookie },
        payload: { baseUrl: "https://copy.example/v1", model: "m", apiKey: "sk-x" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("LLM_ERROR");
    } finally {
      await app3.close();
    }
  });

  it("test 也可用已保存配置（无 body）；字段非法 → 422", async () => {
    const cookie = await loginAsRole("admin");
    await patch(URL, cookie, {
      baseUrl: "https://copy.example/v1",
      model: "m",
      apiKey: "sk-saved-config-key",
    });
    const fn = llmOkFetch();
    const app2 = appWithFetch(fn);
    try {
      const res = await app2.inject({ method: "POST", url: TEST, headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const init = fn.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-saved-config-key");
    } finally {
      await app2.close();
    }

    const bad = await postJson(TEST, cookie, { baseUrl: 123 });
    expect(bad.statusCode).toBe(422);
  });
});
