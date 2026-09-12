// 文案工作台（K60）：模板词表 CRUD + live 唯一 (dimension,name) + OCC + RBAC；
// 文案 CRUD + q 搜索 + 分页；generate/audit LLM mock 注入（正常/未配置/上游错误/坏 JSON/兜底解析）。
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
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

type JsonBody = Record<string, unknown>;

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) =>
  app.inject({ method: "DELETE", url, headers: { cookie } });

const TEMPLATES = "/api/v1/copywriting/templates";
const ITEMS = "/api/v1/copywriting/items";
const GENERATE = "/api/v1/copywriting/generate";
const AUDIT = "/api/v1/copywriting/audit";
const REVIEW = "/api/v1/copywriting/review";

/** 直接种 system_configs code='llm'（等价于设置页已保存） */
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

/** vi.fn 包装的 fetch mock：可注入 app，也可读 mock.calls 断言请求体 */
type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

function llmOk(payload: unknown): FetchMock {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as FetchMock;
}

function llmRaw(content: string): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function llmFailing(status: number): typeof fetch {
  return vi.fn(async () => new Response("upstream boom", { status })) as unknown as typeof fetch;
}

/** 用指定 llmFetch 重建 app（同库同时钟），调用方负责 close */
function appWithLlm(fetchFn: typeof fetch): FastifyInstance {
  return buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0, llmFetch: fetchFn });
}

async function createTemplate(payload: JsonBody = {}) {
  const { cookie } = await loginAsRole("admin");
  const res = await post(TEMPLATES, cookie, {
    dimension: "topic",
    name: "默认模板",
    content: "围绕主题写三段",
    ...payload,
  });
  return { cookie, res };
}

describe("RBAC（copywriting 资源，K60）", () => {
  it("未登录 → 401", async () => {
    expect((await app.inject({ method: "GET", url: TEMPLATES })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: ITEMS })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: GENERATE, payload: { topic: "x" } })).statusCode).toBe(401);
  });

  it("assistant：GET 200；模板写操作 403；generate/audit 403；文案写操作 403", async () => {
    const { cookie } = await loginAsRole("assistant");
    expect((await get(TEMPLATES, cookie)).statusCode).toBe(200);
    expect((await get(ITEMS, cookie)).statusCode).toBe(200);
    expect(
      (await post(TEMPLATES, cookie, { dimension: "topic", name: "x", content: "y" })).statusCode,
    ).toBe(403);
    expect((await patch(`${TEMPLATES}/1`, cookie, { name: "z", updatedAt: 1 })).statusCode).toBe(403);
    expect((await del(`${TEMPLATES}/1`, cookie)).statusCode).toBe(403);
    expect((await post(GENERATE, cookie, { topic: "主题" })).statusCode).toBe(403);
    expect((await post(AUDIT, cookie, { content: "正文" })).statusCode).toBe(403);
    expect((await post(REVIEW, cookie, { content: "正文" })).statusCode).toBe(403);
    expect((await post(ITEMS, cookie, { title: "t", content: "c" })).statusCode).toBe(403);
  });

  it("operator：模板与文案写操作放行", async () => {
    const { cookie } = await loginAsRole("operator");
    const created = await post(TEMPLATES, cookie, { dimension: "goal", name: "促单", content: "强调限时" });
    expect(created.statusCode).toBe(201);
    const tpl = created.json().data;
    clock.t += 1000;
    expect(
      (await patch(`${TEMPLATES}/${tpl.id}`, cookie, { name: "促单2", updatedAt: tpl.updatedAt })).statusCode,
    ).toBe(200);
    expect((await del(`${TEMPLATES}/${tpl.id}`, cookie)).statusCode).toBe(204);

    const item = await post(ITEMS, cookie, { title: "文案A", content: "正文" });
    expect(item.statusCode).toBe(201);
    clock.t += 1000;
    expect(
      (await patch(`${ITEMS}/${item.json().data.id}`, cookie, {
        title: "文案B",
        updatedAt: item.json().data.updatedAt,
      })).statusCode,
    ).toBe(200);
  });
});

describe("模板 CRUD", () => {
  it("创建默认值 sort=0/enabled=true；审计列展开；DTO 无 snake_case", async () => {
    const { id, cookie } = await loginAsRole("operator");
    const created = await post(TEMPLATES, cookie, { dimension: "audience", name: "宝妈", content: "面向宝妈" });
    expect(created.statusCode).toBe(201);
    const data = created.json().data;
    expect(data.dimension).toBe("audience");
    expect(data.sort).toBe(0);
    expect(data.enabled).toBe(true);
    expect(data.createdBy).toEqual({ id, nickname: "昵称-operator" });
    expect(JSON.stringify(data)).not.toContain("created_at");
  });

  it("同 dimension live 同名 → 409 且带当前行；不同 dimension 同名 → 201", async () => {
    const { cookie } = await loginAsRole("admin");
    const first = await post(TEMPLATES, cookie, { dimension: "topic", name: "同名", content: "a" });
    expect(first.statusCode).toBe(201);

    const dup = await post(TEMPLATES, cookie, { dimension: "topic", name: "同名", content: "b" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
    expect(dup.json().data.id).toBe(first.json().data.id);
    expect(dup.json().data.name).toBe("同名");

    const other = await post(TEMPLATES, cookie, { dimension: "goal", name: "同名", content: "b" });
    expect(other.statusCode).toBe(201);
  });

  it("列表：dimension/enabled 过滤；sort asc 排序；meta 不分页（基线含种子模板）", async () => {
    const { cookie } = await loginAsRole("admin");
    // 种子模板（0031 migration）已在词表：断言用前后差值，不依赖种子数量
    const base = (await get(TEMPLATES, cookie)).json().meta.total;
    const baseTopic = (await get(`${TEMPLATES}?dimension=topic`, cookie)).json().meta.total;

    await post(TEMPLATES, cookie, { dimension: "topic", name: "T2", content: "x", sort: 22 });
    await post(TEMPLATES, cookie, { dimension: "topic", name: "T1", content: "x", sort: 21 });
    await post(TEMPLATES, cookie, { dimension: "polish", name: "P1", content: "x" });
    await post(TEMPLATES, cookie, { dimension: "topic", name: "T0", content: "x", sort: 20, enabled: false });

    const all = await get(TEMPLATES, cookie);
    expect(all.statusCode).toBe(200);
    expect(all.json().meta.total).toBe(base + 4);
    expect(all.json().meta.pageSize).toBe(base + 4);

    const topic = await get(`${TEMPLATES}?dimension=topic`, cookie);
    expect(topic.json().meta.total).toBe(baseTopic + 3);
    const topicNames = topic.json().data.map((t: { name: string }) => t.name);
    const createdIdx = ["T0", "T1", "T2"].map((n) => topicNames.indexOf(n));
    expect(createdIdx).toEqual([...createdIdx].sort((a, b) => a - b)); // 创建的三条按 sort asc 相对有序

    const enabled = await get(`${TEMPLATES}?dimension=topic&enabled=true`, cookie);
    expect(enabled.json().meta.total).toBe(baseTopic + 2);
    const disabled = await get(`${TEMPLATES}?enabled=false`, cookie);
    expect(disabled.json().meta.total).toBe(1);
    expect(disabled.json().data[0].name).toBe("T0");
  });

  it("PATCH：改名/排序/停用；OCC updatedAt 不符 → 409 带当前行；空 patch → 422", async () => {
    const { cookie, res } = await createTemplate();
    const tpl = res.json().data;

    clock.t += 1000;
    const ok = await patch(`${TEMPLATES}/${tpl.id}`, cookie, {
      name: "新名",
      sort: 7,
      enabled: false,
      updatedAt: tpl.updatedAt,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.name).toBe("新名");
    expect(ok.json().data.sort).toBe(7);
    expect(ok.json().data.enabled).toBe(false);

    clock.t += 1000;
    const stale = await patch(`${TEMPLATES}/${tpl.id}`, cookie, { sort: 9, updatedAt: tpl.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().data.sort).toBe(7);

    clock.t += 1000;
    const empty = await patch(`${TEMPLATES}/${tpl.id}`, cookie, { updatedAt: ok.json().data.updatedAt });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe("VALIDATION");

    expect(
      (await patch(`${TEMPLATES}/${tpl.id}`, cookie, { name: "x" })).statusCode,
    ).toBe(422); // 缺 updatedAt
  });

  it("PATCH 改名撞 live 同名 → 409", async () => {
    const { cookie } = await loginAsRole("admin");
    await post(TEMPLATES, cookie, { dimension: "topic", name: "甲", content: "a" });
    const b = await post(TEMPLATES, cookie, { dimension: "topic", name: "乙", content: "b" });
    const tplB = b.json().data;

    clock.t += 1000;
    const res = await patch(`${TEMPLATES}/${tplB.id}`, cookie, { name: "甲", updatedAt: tplB.updatedAt });
    expect(res.statusCode).toBe(409);
    expect(res.json().data.name).toBe("甲");
  });

  it("DELETE 软删：204；重复删 404；软删后同名可重建", async () => {
    const { cookie, res } = await createTemplate({ name: "一次性" });
    const tpl = res.json().data;

    expect((await del(`${TEMPLATES}/${tpl.id}`, cookie)).statusCode).toBe(204);
    expect((await del(`${TEMPLATES}/${tpl.id}`, cookie)).statusCode).toBe(404);

    const row = tmp.sqlite.prepare("SELECT deleted_at FROM copy_templates WHERE id = ?").get(tpl.id) as {
      deleted_at: number;
    };
    expect(row.deleted_at).toBe(clock.t);

    const reuse = await post(TEMPLATES, cookie, { dimension: "topic", name: "一次性", content: "x" });
    expect(reuse.statusCode).toBe(201);
    expect(reuse.json().data.id).not.toBe(tpl.id);
  });
});

describe("POST /copywriting/generate", () => {
  it("未配置 LLM → 422 中文提示", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post(GENERATE, cookie, { topic: "开业活动" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("系统设置");
  });

  it("topic 缺失 → 422 VALIDATION", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post(GENERATE, cookie, {})).statusCode).toBe(422);
  });

  it("mock 正常返回 → 200 {title, content}", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const app2 = appWithLlm(llmOk({ title: "周年庆推文", content: "生成的文案" }));
    try {
      const res = await app2.inject({
        method: "POST",
        url: GENERATE,
        headers: { cookie },
        payload: { topic: "周年庆", goal: "拉新" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.title).toBe("周年庆推文");
      expect(res.json().data.content).toBe("生成的文案");
    } finally {
      await app2.close();
    }
  });

  it("缺 systemPrompt → 用内置默认系统提示词（builtin 行文本注入 messages[0]）", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const fn = llmOk({ title: "t", content: "c" });
    const app2 = appWithLlm(fn);
    try {
      const res = await app2.inject({
        method: "POST",
        url: GENERATE,
        headers: { cookie },
        payload: { topic: "t" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(String(fn.mock.calls[0]![1]!.body));
      expect(body.messages[0].content).toContain("私域运营文案专家");
      expect(body.messages[0].content).toContain("title");
    } finally {
      await app2.close();
    }
  });

  it("自定义 systemPrompt 快照 → 覆盖内置默认", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const fn = llmOk({ title: "t", content: "c" });
    const app2 = appWithLlm(fn);
    try {
      const res = await app2.inject({
        method: "POST",
        url: GENERATE,
        headers: { cookie },
        payload: { topic: "t", systemPrompt: "只许输出五言绝句" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(String(fn.mock.calls[0]![1]!.body));
      expect(body.messages[0].content).toBe("只许输出五言绝句");
    } finally {
      await app2.close();
    }
  });

  it("LLM 未给 title → 回退正文首行截断（保存必填兜底）", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const app2 = appWithLlm(llmOk({ content: "开业大促来袭\n正文段落" }));
    try {
      const res = await app2.inject({
        method: "POST",
        url: GENERATE,
        headers: { cookie },
        payload: { topic: "t" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.title).toBe("开业大促来袭");
    } finally {
      await app2.close();
    }
  });

  it("LLM 上游 500 → 502 LLM_ERROR；坏 JSON → 502；content 非字符串 → 502", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");

    const appFail = appWithLlm(llmFailing(500));
    try {
      const res = await appFail.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "t" } });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("LLM_ERROR");
    } finally {
      await appFail.close();
    }

    const appBad = appWithLlm(llmRaw("这不是 JSON"));
    try {
      const res = await appBad.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "t" } });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("LLM_ERROR");
    } finally {
      await appBad.close();
    }

    const appNoContent = appWithLlm(llmOk({ content: 42 }));
    try {
      const res = await appNoContent.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "t" } });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("LLM_ERROR");
    } finally {
      await appNoContent.close();
    }
  });
});

describe("POST /copywriting/audit", () => {
  it("content 缺失 → 422；未配置 LLM → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post(AUDIT, cookie, {})).statusCode).toBe(422);
    const res = await post(AUDIT, cookie, { content: "正文" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("系统设置");
  });

  it("mock 完整 report → 200 解析正确", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const report = {
      verdict: "warn",
      summary: "整体可用但结尾突兀",
      issues: [{ aspect: "结尾", detail: "缺少行动号召", suggestion: "加一句引导" }],
    };
    const app2 = appWithLlm(llmOk(report));
    try {
      const res = await app2.inject({
        method: "POST",
        url: AUDIT,
        headers: { cookie },
        payload: { content: "姐妹们看过来", audience: "宝妈" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual(report);
    } finally {
      await app2.close();
    }
  });

  it("缺字段/非法 verdict → 兜底（verdict=warn，issues=[]，字段补空串）", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const app2 = appWithLlm(
      llmOk({ verdict: "bogus", summary: 123, issues: [{ aspect: "a", detail: 5 }, "not-object"] }),
    );
    try {
      const res = await app2.inject({ method: "POST", url: AUDIT, headers: { cookie }, payload: { content: "x" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        verdict: "warn",
        summary: "",
        issues: [{ aspect: "a", detail: "", suggestion: "" }],
      });
    } finally {
      await app2.close();
    }
  });
});

describe("POST /copywriting/review（逆向检查：第二轮 LLM 审修，修订稿才是产出）", () => {
  it("content 缺失 → 422；未配置 LLM → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post(REVIEW, cookie, {})).statusCode).toBe(422);
    const res = await post(REVIEW, cookie, { content: "正文" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("系统设置");
  });

  it("mock 修订稿 → 200 返回修订后 {title, content}（可覆盖原标题）", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const fn = llmOk({ title: "修订后标题", content: "修订后的正文" });
    const app2 = appWithLlm(fn);
    try {
      const res = await app2.inject({
        method: "POST",
        url: REVIEW,
        headers: { cookie },
        payload: { title: "原标题", content: "待审正文", topic: "开营", audience: "宝妈" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ title: "修订后标题", content: "修订后的正文" });
      const body = JSON.parse(String(fn.mock.calls[0]![1]!.body));
      expect(body.messages[0].content).toContain("终审编辑"); // 内置逆向检查提示词
      expect(body.messages[1].content).toContain("原标题：原标题");
      expect(body.messages[1].content).toContain("待审正文");
      expect(body.temperature).toBe(0.3);
    } finally {
      await app2.close();
    }
  });

  it("修订稿未给 title → 沿用输入标题；无输入标题 → 正文首行兜底", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const appKeep = appWithLlm(llmOk({ content: "修订后的正文" }));
    try {
      const res = await appKeep.inject({
        method: "POST",
        url: REVIEW,
        headers: { cookie },
        payload: { title: "原标题", content: "待审正文" },
      });
      expect(res.json().data.title).toBe("原标题");
    } finally {
      await appKeep.close();
    }

    const appFallback = appWithLlm(llmOk({ content: "兜底标题行\n修订正文" }));
    try {
      const res = await appFallback.inject({
        method: "POST",
        url: REVIEW,
        headers: { cookie },
        payload: { content: "待审正文" },
      });
      expect(res.json().data.title).toBe("兜底标题行");
    } finally {
      await appFallback.close();
    }
  });

  it("自定义 reviewPrompt 快照 → 覆盖内置；content 非字符串 → 502", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const fn = llmOk({ content: "修订后的正文" });
    const app2 = appWithLlm(fn);
    try {
      const res = await app2.inject({
        method: "POST",
        url: REVIEW,
        headers: { cookie },
        payload: { content: "待审正文", reviewPrompt: "只压缩到 50 字内" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(String(fn.mock.calls[0]![1]!.body));
      expect(body.messages[0].content).toBe("只压缩到 50 字内");
    } finally {
      await app2.close();
    }

    const appBad = appWithLlm(llmOk({ content: 42 }));
    try {
      const res = await appBad.inject({
        method: "POST",
        url: REVIEW,
        headers: { cookie },
        payload: { content: "待审正文" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("LLM_ERROR");
    } finally {
      await appBad.close();
    }
  });
});

describe("文案 CRUD", () => {
  it("创建：六段快照 + 审计列；GET 单条；软删后 GET 404", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const auditSnapshot = JSON.stringify({ verdict: "pass", summary: "ok", issues: [] });
    const created = await post(ITEMS, cookie, {
      title: "开业推文",
      topic: "开业",
      outputType: "朋友圈",
      content: "正文内容",
      auditReport: auditSnapshot,
    });
    expect(created.statusCode).toBe(201);
    const item = created.json().data;
    expect(item.title).toBe("开业推文");
    expect(item.outputType).toBe("朋友圈");
    expect(item.background).toBeNull();
    expect(item.auditReport).toBe(auditSnapshot);
    expect(item.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });

    const one = await get(`${ITEMS}/${item.id}`, cookie);
    expect(one.statusCode).toBe(200);
    expect(one.json().data.id).toBe(item.id);

    expect((await del(`${ITEMS}/${item.id}`, cookie)).statusCode).toBe(204);
    expect((await get(`${ITEMS}/${item.id}`, cookie)).statusCode).toBe(404);
    expect((await del(`${ITEMS}/${item.id}`, cookie)).statusCode).toBe(404);
  });

  it("q 搜索命中 title 与 content；分页 meta；LIKE 通配符转义", async () => {
    const { cookie } = await loginAsRole("admin");
    await post(ITEMS, cookie, { title: "周年庆海报", content: "普通正文" });
    await post(ITEMS, cookie, { title: "日常推送", content: "提到周年庆的内容" });
    await post(ITEMS, cookie, { title: "无关", content: "无关 100% 内容" });

    const byTitle = await get(`${ITEMS}?q=${encodeURIComponent("周年庆")}`, cookie);
    expect(byTitle.json().meta.total).toBe(2);

    const byContent = await get(`${ITEMS}?q=${encodeURIComponent("提到")}`, cookie);
    expect(byContent.json().meta.total).toBe(1);
    expect(byContent.json().data[0].title).toBe("日常推送");

    // % 当字面量，不当通配符
    const literal = await get(`${ITEMS}?q=${encodeURIComponent("100%")}`, cookie);
    expect(literal.json().meta.total).toBe(1);
    expect(literal.json().data[0].title).toBe("无关");

    const paged = await get(`${ITEMS}?page=2&pageSize=2`, cookie);
    expect(paged.json().meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(paged.json().data.length).toBe(1);

    const sorted = await get(`${ITEMS}?sort=title&order=asc`, cookie);
    const titles = sorted.json().data.map((i: { title: string }) => i.title);
    expect(titles).toEqual([...titles].sort());
  });

  it("PATCH：键存在才 SET + null 清空；OCC 409；空 patch 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const created = await post(ITEMS, cookie, { title: "t", topic: "主题", content: "c" });
    const item = created.json().data;

    clock.t += 1000;
    const ok = await patch(`${ITEMS}/${item.id}`, cookie, { topic: null, title: "t2", updatedAt: item.updatedAt });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.title).toBe("t2");
    expect(ok.json().data.topic).toBeNull();
    expect(ok.json().data.content).toBe("c"); // 缺席不动

    clock.t += 1000;
    const stale = await patch(`${ITEMS}/${item.id}`, cookie, { title: "t3", updatedAt: item.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().data.title).toBe("t2");

    clock.t += 1000;
    const empty = await patch(`${ITEMS}/${item.id}`, cookie, { updatedAt: ok.json().data.updatedAt });
    expect(empty.statusCode).toBe(422);

    // 软删行 PATCH → 404
    await del(`${ITEMS}/${item.id}`, cookie);
    clock.t += 1000;
    expect(
      (await patch(`${ITEMS}/${item.id}`, cookie, { title: "x", updatedAt: ok.json().data.updatedAt }))
        .statusCode,
    ).toBe(404);
  });

  it("assistant：GET 单条 200；写操作 403", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    const created = await post(ITEMS, adminCookie, { title: "t", content: "c" });
    const item = created.json().data;

    const { cookie } = await loginAsRole("assistant");
    expect((await get(`${ITEMS}/${item.id}`, cookie)).statusCode).toBe(200);
    expect(
      (await patch(`${ITEMS}/${item.id}`, cookie, { title: "x", updatedAt: item.updatedAt })).statusCode,
    ).toBe(403);
    expect((await del(`${ITEMS}/${item.id}`, cookie)).statusCode).toBe(403);
  });
});

// system prompt 可维护（K60+）：generate/audit 的 system prompt 走 system_configs
// code='copywritingPrompts'，未配置/字段为空串 → 回退内置默认（女商红线版）。
function seedCopyPromptsRow(value: Record<string, unknown>): void {
  tmp.db
    .insert(systemConfigs)
    .values({
      code: "copywritingPrompts",
      value: JSON.stringify(value),
      updatedAt: clock.t,
      updatedBy: null,
    })
    .onConflictDoNothing()
    .run();
}

/** 直接种 system_configs code='copywritingLlm'（文案专用 LLM） */
function seedCopyLlmRow(value: Record<string, unknown>): void {
  tmp.db
    .insert(systemConfigs)
    .values({
      code: "copywritingLlm",
      value: JSON.stringify(value),
      updatedAt: clock.t,
      updatedBy: null,
    })
    .onConflictDoNothing()
    .run();
}

/** 捕获发往 LLM 的 messages（mock 固定正常返回） */
function llmCapture(reply: unknown = { content: "ok" }): {
  fetchFn: typeof fetch;
  systems: string[];
  users: string[];
} {
  const systems: string[] = [];
  const users: string[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    systems.push(body.messages.find((m) => m.role === "system")?.content ?? "");
    users.push(body.messages.find((m) => m.role === "user")?.content ?? "");
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, systems, users };
}

describe("system prompt 走配置（/system/copywriting-prompts）", () => {
  const PROMPTS = "/api/v1/system/copywriting-prompts";

  it("未配置 → generate/audit 用内置默认（女商红线）", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const cap = llmCapture();
    const app2 = appWithLlm(cap.fetchFn);
    try {
      const gen = await app2.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "周年庆" } });
      expect(gen.statusCode).toBe(200);
      expect(cap.systems[0]).toContain("闪光少女斯斯");
      expect(cap.systems[0]).toContain("待核");

      const audit = await app2.inject({ method: "POST", url: AUDIT, headers: { cookie }, payload: { content: "x" } });
      expect(audit.statusCode).toBe(200);
      expect(cap.systems[1]).toContain("审计");
    } finally {
      await app2.close();
    }
  });

  it("PATCH 配置后 generate/audit 使用自定义 system prompt；维度文本仍进 user 消息", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const saved = await patch(PROMPTS, cookie, {
      generateSystemPrompt: "自定义生成 SYSTEM",
      auditSystemPrompt: "自定义审计 SYSTEM",
    });
    expect(saved.statusCode).toBe(200);

    const cap = llmCapture({ content: "ok", verdict: "pass", summary: "s", issues: [] });
    const app2 = appWithLlm(cap.fetchFn);
    try {
      const gen = await app2.inject({
        method: "POST",
        url: GENERATE,
        headers: { cookie },
        payload: { topic: "主题内容", goal: "拉新" },
      });
      expect(gen.statusCode).toBe(200);
      expect(cap.systems[0]).toBe("自定义生成 SYSTEM");
      expect(cap.users[0]).toContain("主题内容：主题内容");
      expect(cap.users[0]).toContain("预期目的：拉新");

      const audit = await app2.inject({ method: "POST", url: AUDIT, headers: { cookie }, payload: { content: "正文" } });
      expect(audit.statusCode).toBe(200);
      expect(cap.systems[1]).toBe("自定义审计 SYSTEM");
    } finally {
      await app2.close();
    }
  });

  it("配置字段为空串 → 该项回退内置默认，另一项保留", async () => {
    seedAiConfigRow();
    seedCopyPromptsRow({ generateSystemPrompt: "", auditSystemPrompt: "仅审计自定义" });
    const { cookie } = await loginAsRole("admin");
    const cap = llmCapture();
    const app2 = appWithLlm(cap.fetchFn);
    try {
      const gen = await app2.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "t" } });
      expect(gen.statusCode).toBe(200);
      expect(cap.systems[0]).toContain("闪光少女斯斯");

      const audit = await app2.inject({ method: "POST", url: AUDIT, headers: { cookie }, payload: { content: "x" } });
      expect(audit.statusCode).toBe(200);
      expect(cap.systems[1]).toBe("仅审计自定义");
    } finally {
      await app2.close();
    }
  });

  it("review 逆向检查同样走配置：默认终审编辑，PATCH reviewSystemPrompt 生效，空串恢复默认", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const cap = llmCapture({ title: "t", content: "修订稿" });
    const app2 = appWithLlm(cap.fetchFn);
    try {
      const res = await app2.inject({ method: "POST", url: REVIEW, headers: { cookie }, payload: { content: "待审" } });
      expect(res.statusCode).toBe(200);
      expect(cap.systems[0]).toContain("终审编辑");
    } finally {
      await app2.close();
    }

    clock.t += 1000;
    const saved = await patch(PROMPTS, cookie, { reviewSystemPrompt: "自定义逆向 SYSTEM" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.reviewSystemPrompt).toBe("自定义逆向 SYSTEM");

    const cap2 = llmCapture({ title: "t", content: "修订稿" });
    const app3 = appWithLlm(cap2.fetchFn);
    try {
      const res = await app3.inject({ method: "POST", url: REVIEW, headers: { cookie }, payload: { content: "待审" } });
      expect(res.statusCode).toBe(200);
      expect(cap2.systems[0]).toBe("自定义逆向 SYSTEM");
    } finally {
      await app3.close();
    }

    clock.t += 1000;
    const restored = await patch(PROMPTS, cookie, { reviewSystemPrompt: "" });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.reviewSystemPrompt).toContain("终审编辑");
  });
});

describe("LLM 选取：文案专用（code='copywritingLlm'）优先，回退系统级（code='llm'）", () => {
  /** 记录请求 URL/头/体的 fetch mock（返回可解析 JSON 的 LLM 应答） */
  function llmProbe(reply: Record<string, unknown>): {
    fn: FetchMock;
    urls: string[];
    auths: (string | null)[];
    models: string[];
  } {
    const urls: string[] = [];
    const auths: (string | null)[] = [];
    const models: string[] = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      auths.push(headers.Authorization ?? null);
      models.push((JSON.parse(String(init?.body)) as { model: string }).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as FetchMock;
    return { fn, urls, auths, models };
  }

  it("专用配置完整 → generate/audit/review 都走专用 baseUrl + 专用 key", async () => {
    seedAiConfigRow(); // 系统级也在，验证「优先」而非「唯一」
    seedCopyLlmRow({
      provider: "dedicated",
      baseUrl: "https://copy-llm.example/v1",
      apiKey: "sk-dedicated",
      model: "copy-model",
    });
    const { cookie } = await loginAsRole("admin");
    const probe = llmProbe({ title: "t", content: "c", verdict: "pass", summary: "s", issues: [] });
    const app2 = appWithLlm(probe.fn);
    try {
      const gen = await app2.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "t" } });
      expect(gen.statusCode).toBe(200);
      expect(probe.urls[0]).toBe("https://copy-llm.example/v1/chat/completions");
      expect(probe.auths[0]).toBe("Bearer sk-dedicated");
      expect(probe.models[0]).toBe("copy-model");

      await app2.inject({ method: "POST", url: AUDIT, headers: { cookie }, payload: { content: "x" } });
      expect(probe.urls[1]).toContain("copy-llm.example");
      await app2.inject({ method: "POST", url: REVIEW, headers: { cookie }, payload: { content: "x" } });
      expect(probe.urls[2]).toContain("copy-llm.example");
    } finally {
      await app2.close();
    }
  });

  it("专用配置不完整（缺 apiKey）→ 回退系统级配置", async () => {
    seedAiConfigRow();
    seedCopyLlmRow({ provider: "dedicated", baseUrl: "https://copy-llm.example/v1", apiKey: "", model: "copy-model" });
    const { cookie } = await loginAsRole("admin");
    const probe = llmProbe({ title: "t", content: "c" });
    const app2 = appWithLlm(probe.fn);
    try {
      const res = await app2.inject({ method: "POST", url: GENERATE, headers: { cookie }, payload: { topic: "t" } });
      expect(res.statusCode).toBe(200);
      expect(probe.urls[0]).toBe("https://llm.example/v1/chat/completions");
    } finally {
      await app2.close();
    }
  });

  it("专用与系统级都未配置 → 422，提示两个配置入口", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post(GENERATE, cookie, { topic: "t" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("LLM 打标配置");
    expect(res.json().error.message).toContain("文案专用 LLM");
  });
});
