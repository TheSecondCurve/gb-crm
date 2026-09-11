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

function llmOk(payload: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
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

  it("列表：dimension/enabled 过滤；sort asc 排序；meta 不分页", async () => {
    const { cookie } = await loginAsRole("admin");
    await post(TEMPLATES, cookie, { dimension: "topic", name: "T2", content: "x", sort: 2 });
    await post(TEMPLATES, cookie, { dimension: "topic", name: "T1", content: "x", sort: 1 });
    await post(TEMPLATES, cookie, { dimension: "polish", name: "P1", content: "x" });
    await post(TEMPLATES, cookie, { dimension: "topic", name: "T0", content: "x", enabled: false });

    const all = await get(TEMPLATES, cookie);
    expect(all.statusCode).toBe(200);
    expect(all.json().meta.total).toBe(4);
    expect(all.json().meta).toEqual({ page: 1, pageSize: 4, total: 4 });

    const topic = await get(`${TEMPLATES}?dimension=topic`, cookie);
    expect(topic.json().meta.total).toBe(3);
    expect(topic.json().data.map((t: { name: string }) => t.name)).toEqual(["T0", "T1", "T2"]);

    const enabled = await get(`${TEMPLATES}?dimension=topic&enabled=true`, cookie);
    expect(enabled.json().meta.total).toBe(2);
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

  it("mock 正常返回 → 200 content 正确", async () => {
    seedAiConfigRow();
    const { cookie } = await loginAsRole("admin");
    const app2 = appWithLlm(llmOk({ content: "生成的文案" }));
    try {
      const res = await app2.inject({
        method: "POST",
        url: GENERATE,
        headers: { cookie },
        payload: { topic: "周年庆", goal: "拉新" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.content).toBe("生成的文案");
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
