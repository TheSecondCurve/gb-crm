// K62 增量触发补盲：新客户带来历/备注即抽取、PATCH 来历/备注重抽（无关 PATCH 不触发）、
// 文本类语料建/改/删对关联客户入队（解除关联也重抽旧客户）、扫尾判陈旧扩展（来历直改/语料直写）、
// transcript 源清理（资料软删或解除关联 → 信号软删）。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { extractCustomerSignals } from "../../src/modules/insights/extract.js";
import { listStaleCustomerIds } from "../../src/modules/insights/repo.js";
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

async function loginAsRole(role: "admin" | "operator", username = `u-${role}`): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) => app.inject({ method: "DELETE", url, headers: { cookie } });

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

const queueCount = (): number =>
  (tmp.sqlite.prepare("SELECT COUNT(*) c FROM background_jobs WHERE type='insights-signal-extract'").get() as { c: number }).c;

describe("增量触发补盲（K62）", () => {
  it("新建客户带来历 → 入队；不带文本 → 不入队；PATCH 来历 → 入队，PATCH 电话/标签 → 不入队", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");

    const withStory = await post("/api/v1/customers", admin.cookie, { nickname: "带来历", originStory: "李姐介绍，做饰品电商" });
    expect(withStory.statusCode).toBe(201);
    expect(queueCount()).toBe(1);

    await post("/api/v1/customers", admin.cookie, { nickname: "无文本" });
    expect(queueCount()).toBe(1); // 无来历/备注不入队

    const noStory = await post("/api/v1/customers", admin.cookie, { nickname: "只有备注", notes: "  " });
    expect(noStory.statusCode).toBe(201);
    expect(queueCount()).toBe(1); // 空白备注不算文本

    const dto = withStory.json().data;
    const patched = await patch(`/api/v1/customers/${dto.id}`, admin.cookie, { originStory: "改写：现在做美妆出海", updatedAt: dto.updatedAt });
    expect(patched.statusCode).toBe(200);
    expect(queueCount()).toBe(2);

    const after = patched.json().data;
    const phoneOnly = await patch(`/api/v1/customers/${dto.id}`, admin.cookie, { phone: "13800000000", updatedAt: after.updatedAt });
    expect(phoneOnly.statusCode).toBe(200);
    expect(queueCount()).toBe(2); // 无关 PATCH 不触发
  });

  it("LLM 未配置：来历入队静默跳过，客户照常创建", async () => {
    const admin = await loginAsRole("admin");
    const res = await post("/api/v1/customers", admin.cookie, { nickname: "没LLM", originStory: "有文本" });
    expect(res.statusCode).toBe(201);
    expect(queueCount()).toBe(0);
  });

  it("文本类语料：建/改/删对关联客户入队；解除关联对旧客户也入队；非文本类不入队", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const c1 = (await post("/api/v1/customers", admin.cookie, { nickname: "语料客户A" })).json().data.id;
    const c2 = (await post("/api/v1/customers", admin.cookie, { nickname: "语料客户B" })).json().data.id;

    const mat = await post("/api/v1/materials", admin.cookie, {
      kind: "text",
      title: "咨询记录",
      content: "聊到想做小红书",
      customerIds: [c1],
    });
    expect(mat.statusCode).toBe(201);
    expect(queueCount()).toBe(1); // c1

    // 改标题（文本类敏感键）→ 重抽
    const mdto = mat.json().data;
    await patch(`/api/v1/materials/${mdto.id}`, admin.cookie, { title: "咨询记录（修订）", updatedAt: mdto.updatedAt });
    expect(queueCount()).toBe(2);

    // 改客户关联 c1→c2：新旧客户都要入队（共 +2）
    const mdto2 = (await app.inject({ method: "GET", url: `/api/v1/materials/${mdto.id}`, headers: { cookie: admin.cookie } })).json().data;
    await patch(`/api/v1/materials/${mdto.id}`, admin.cookie, { customerIds: [c2], updatedAt: mdto2.updatedAt });
    expect(queueCount()).toBe(4);

    // 非文本类不入队
    const audio = await post("/api/v1/materials", admin.cookie, { kind: "audio", title: "录音", url: "https://x/y.mp3", customerIds: [c1] });
    expect(audio.statusCode).toBe(201);
    expect(queueCount()).toBe(4);

    // 删文本类 → 关联客户（现为 c2）入队
    await del(`/api/v1/materials/${mdto.id}`, admin.cookie);
    expect(queueCount()).toBe(5);
  });

  it("扫尾判陈旧：来历被直改（无信号时）、语料直写更新都命中；纯新客户无文本不命中", async () => {
    const admin = await loginAsRole("admin");
    const c1 = (await post("/api/v1/customers", admin.cookie, { nickname: "直改来历", originStory: "原始来历" })).json().data.id;
    const c2 = (await post("/api/v1/customers", admin.cookie, { nickname: "无文本客户" })).json().data.id;

    // 无任何信号：c1 有文本即陈旧；c2 无文本不陈旧
    expect(listStaleCustomerIds(tmp.db)).toContain(c1);
    expect(listStaleCustomerIds(tmp.db)).not.toContain(c2);

    // agent 直写语料（不经 REST，无钩子）→ 语料 updated_at 新于零抽取 → 陈旧
    const c3 = (await post("/api/v1/customers", admin.cookie, { nickname: "语料直写" })).json().data.id;
    tmp.sqlite
      .prepare(
        "INSERT INTO delivery_materials (kind, title, content, created_at, updated_at) VALUES ('text', '直写', '内容', ?, ?)",
      )
      .run(clock.t, clock.t + 1000);
    const matId = Number((tmp.sqlite.prepare("SELECT id FROM delivery_materials WHERE title='直写'").get() as { id: number }).id);
    tmp.sqlite.prepare("INSERT INTO delivery_material_customers (material_id, customer_id) VALUES (?, ?)").run(matId, c3);
    expect(listStaleCustomerIds(tmp.db)).toContain(c3);
  });

  it("transcript 源清理：资料软删 / 解除关联后重抽 → 对应信号软删", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const c1 = (await post("/api/v1/customers", admin.cookie, { nickname: "清理客户" })).json().data.id;
    const mat = (
      await post("/api/v1/materials", admin.cookie, {
        kind: "text",
        title: "场次记录",
        content: "她想找直播代播团队",
        customerIds: [c1],
      })
    ).json().data;

    const mock = llmOk({ signals: [{ type: "need", topic: "直播带货", content: "找直播代播团队", confidence: 0.9, sourceIndex: 0 }] });
    await extractCustomerSignals(tmp.db, c1, { now: clock.t, userId: admin.id }, mock);
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals WHERE deleted_at IS NULL").get() as { c: number }).c).toBe(1);

    // 软删资料 → 重抽（bundle 里该语料消失）→ 信号被清理
    await del(`/api/v1/materials/${mat.id}`, admin.cookie);
    const cleaned = await extractCustomerSignals(tmp.db, c1, { now: clock.t, userId: admin.id }, llmOk({ signals: [] }));
    expect(cleaned.cleaned).toBe(1);
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals WHERE deleted_at IS NULL").get() as { c: number }).c).toBe(0);

    // 重建语料 + 关联 → 抽出信号 → 解除关联 → 重抽清理
    const mat2 = (
      await post("/api/v1/materials", admin.cookie, {
        kind: "text",
        title: "场次记录2",
        content: "她在找供应链",
        customerIds: [c1],
      })
    ).json().data;
    await extractCustomerSignals(tmp.db, c1, { now: clock.t, userId: admin.id }, llmOk({ signals: [{ type: "need", topic: "饰品供应链", content: "找供应链", confidence: 0.9, sourceIndex: 0 }] }));
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals WHERE deleted_at IS NULL").get() as { c: number }).c).toBe(1);
    const detail = (await app.inject({ method: "GET", url: `/api/v1/materials/${mat2.id}`, headers: { cookie: admin.cookie } })).json().data;
    await patch(`/api/v1/materials/${mat2.id}`, admin.cookie, { customerIds: [], updatedAt: detail.updatedAt });
    const cleaned2 = await extractCustomerSignals(tmp.db, c1, { now: clock.t, userId: admin.id }, llmOk({ signals: [] }));
    expect(cleaned2.cleaned).toBe(1);
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals WHERE deleted_at IS NULL").get() as { c: number }).c).toBe(0);
  });
});
