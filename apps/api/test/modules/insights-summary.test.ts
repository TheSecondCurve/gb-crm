// K62 四期：场次语料（transcript/text）进抽取 bundle + AI 经营备忘（LLM 生成 / 规则版回退）。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { extractCustomerSignals } from "../../src/modules/insights/extract.js";
import { insightsSummaryResult } from "../../src/modules/insights/summary.js";
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

async function loginAsRole(role: "admin" | "assistant", username = `u-${role}`): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

function seedAiConfigRow(): void {
  tmp.db
    .insert(systemConfigs)
    .values({
      code: "llm",
      value: JSON.stringify({ provider: "test", baseUrl: "https://llm.example/v1", apiKey: "sk-test", model: "m1" }),
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

describe("场次语料进抽取 bundle", () => {
  it("关联到客户的 text 资料被抽取（source_type=transcript），维护记录仍在", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const cid = (await app.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: admin.cookie }, payload: { nickname: "语料客户" } })).json().data.id;
    // 建一条 text 资料并关联客户（无交付单 → 孤儿允许）
    const matRes = await app.inject({
      method: "POST",
      url: "/api/v1/materials",
      headers: { cookie: admin.cookie },
      payload: { kind: "text", title: "1v1 咨询记录", content: "聊到她想做出海美妆品牌，正在找供应链，也提到团队缺小红书运营", customerIds: [cid] },
    });
    expect(matRes.statusCode).toBe(201);
    await app.inject({ method: "POST", url: `/api/v1/customers/${cid}/records`, headers: { cookie: admin.cookie }, payload: { kind: "follow_up", happenedAt: clock.t, content: "回访" } });

    // mock：两段索引分别命中 transcript（index 0，bundle 中语料排在记录前）与维护记录（index 1）
    const result = await extractCustomerSignals(
      tmp.db,
      cid,
      { now: clock.t, userId: admin.id },
      llmOk({
        signals: [
          { type: "need", topic: "美妆供应链", content: "为出海美妆品牌找供应链", confidence: 0.9, sourceIndex: 0 },
          { type: "interest_hint", topic: "小红书运营", content: "团队缺小红书运营", confidence: 0.8, sourceIndex: 0 },
        ],
      }),
    );
    expect(result.inserted).toBe(2);
    const rows = tmp.sqlite.prepare("SELECT source_type, source_id FROM customer_signals ORDER BY id").all() as { source_type: string; source_id: number }[];
    expect(rows.every((r) => r.source_type === "transcript")).toBe(true);
    expect(rows[0]!.source_id).toBe(matRes.json().data.id);
  });
});

describe("AI 经营备忘 POST /insights/summary", () => {
  it("LLM 可用：生成版（source=llm）；assistant 403", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    await app.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: admin.cookie }, payload: { nickname: "备忘客户" } });
    await app.close();

    // 带 LLM mock 重建 app（端点走注入的 fetchFn）
    const mock = llmOk({ summary: "先唤醒沉睡客户，再跟进断线线索。" });
    app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0, llmFetch: mock });
    const res = await app.inject({ method: "POST", url: "/api/v1/insights/summary", headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.source).toBe("llm");
    expect(body.data.summary).toContain("沉睡客户");
    expect(mock).toHaveBeenCalled();

    const asst = await loginAsRole("assistant");
    expect((await app.inject({ method: "POST", url: "/api/v1/insights/summary", headers: { cookie: asst.cookie } })).statusCode).toBe(403);
  });

  it("LLM 未配置 / 上游失败：回退规则版（source=rule，不报错）", async () => {
    const admin = await loginAsRole("admin");
    await app.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: admin.cookie }, payload: { nickname: "规则客户" } });

    // 未配置
    const rule = await insightsSummaryResult(tmp.db, clock.t);
    expect(rule.source).toBe("rule");
    expect(rule.summary).toContain("守护台");

    // 配置了但上游 500
    seedAiConfigRow();
    const failing = vi.fn(async () => new Response("upstream boom", { status: 500 })) as unknown as typeof fetch;
    const fallback = await insightsSummaryResult(tmp.db, clock.t, failing);
    expect(fallback.source).toBe("rule");
    expect(fallback.summary).toContain("守护台");
  });
});
