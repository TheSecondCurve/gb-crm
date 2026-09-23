// K62 客户洞察（insights）：温度引擎纯函数 + 信号 ingest 幂等（跳过/取代/合并/TTL）+
// 透视台/深潜/信号读写/词表合并 REST + RBAC + 抽取任务（LLM mock + 词表种子 + 记录入队钩子）。
import { TEMPERATURE } from "@gb-crm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { JOB_TYPES } from "../../src/modules/jobs/registry.js";
import { extractCustomerSignals, runSignalExtractJob } from "../../src/modules/insights/extract.js";
import { ingestExtractions } from "../../src/modules/insights/service.js";
import {
  activeDeliveryWeight,
  computeTemperature,
  computeTemperatureSeries,
} from "../../src/modules/insights/temperature.js";
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

async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

type JsonBody = Record<string, unknown>;
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function createCustomer(cookie: string, nickname: string, extra: JsonBody = {}): Promise<number> {
  const res = await post("/api/v1/customers", cookie, { nickname, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

async function createRecord(cookie: string, customerId: number, payload: JsonBody): Promise<{ id: number; updatedAt: number }> {
  const res = await post(`/api/v1/customers/${customerId}/records`, cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

async function createDeal(cookie: string, payload: JsonBody): Promise<number> {
  const res = await post("/api/v1/deals", cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
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

const DAY = 86_400_000;

// ── 温度引擎（纯函数） ──

describe("温度引擎 computeTemperature", () => {
  it("一周内 paid 成交 ≈ 76（标定锚点）", () => {
    const now = Date.now();
    const temp = computeTemperature([{ customerId: 1, at: now - 8 * DAY, weight: 8 }], now);
    expect(temp).toBe(61); // 8 × 2^(-8/21) × 10 = 61.4 → 61
  });

  it("近期 lead + 较早 follow_up 组合温度", () => {
    const now = Date.now();
    const temp = computeTemperature(
      [
        { customerId: 1, at: now - 3 * DAY, weight: 4 },
        { customerId: 1, at: now - 10 * DAY, weight: 2 },
      ],
      now,
    );
    expect(temp).toBeGreaterThan(40);
    expect(temp).toBeLessThan(65);
  });

  it("90 天前最后一次跟进 ≈ 冰点；退款负权重 clamp 到 0", () => {
    const now = Date.now();
    expect(computeTemperature([{ customerId: 1, at: now - 90 * DAY, weight: 2 }], now)).toBe(1);
    expect(computeTemperature([{ customerId: 1, at: now - 1 * DAY, weight: -6 }], now)).toBe(0);
  });

  it("windowDays 时间机器：窗口外事件不计入", () => {
    const now = Date.now();
    const events = [
      { customerId: 1, at: now - 10 * DAY, weight: 8 },
      { customerId: 1, at: now - 40 * DAY, weight: 8 },
    ];
    const with30 = computeTemperature(events, now, 30);
    const withoutWindow = computeTemperature(events, now);
    expect(with30).toBe(computeTemperature([events[0]!], now, 30));
    expect(withoutWindow).toBeGreaterThan(with30); // 40 天前的事件只在无窗口时计入
  });

  it("序列：13 个点、首点最旧、值域 0-100", () => {
    const now = Date.now();
    const series = computeTemperatureSeries([{ customerId: 1, at: now - 5 * DAY, weight: 8 }], now, 180, 13);
    expect(series).toHaveLength(13);
    expect(series[0]!.at).toBeLessThan(series[12]!.at);
    for (const p of series) expect(p.temp).toBeGreaterThanOrEqual(0);
  });

  it("activeDeliveryWeight：至少 1、按周递增、封顶 3", () => {
    const now = Date.now();
    expect(activeDeliveryWeight(now - 2 * DAY, now)).toBe(1);
    expect(activeDeliveryWeight(now - 20 * DAY, now)).toBe(3); // ceil(20/7)=3
    expect(activeDeliveryWeight(now - 400 * DAY, now)).toBe(TEMPERATURE.eventWeights.activeDeliveryCap);
  });
});

// ── 信号 ingest 幂等（service 直调） ──

describe("ingestExtractions 幂等语义", () => {
  it("新事实插入；重复 ingest 同源同事实 → skipped（无新行）；同源异事实 → 旧行被取代", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "王总");
    await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: clock.t - 5 * DAY, content: "咨询了商业下午茶" });
    const recRow = tmp.sqlite.prepare("SELECT id FROM customer_maintenance_records WHERE customer_id=?").get(cid) as { id: number };

    const audit = { now: clock.t, userId: admin.id };
    const ext = [
      {
        type: "intent" as const,
        topic: "商业下午茶",
        content: "咨询商业下午茶，问了排期和价格",
        confidence: 0.9,
        sourceType: "maintenance_record" as const,
        sourceId: recRow.id,
        sourceAt: clock.t - 5 * DAY,
      },
    ];

    const first = ingestExtractions(tmp.db, cid, ext, "v1", audit);
    expect(first).toMatchObject({ inserted: 1, merged: 0, skipped: 0 });
    expect(tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals").get()).toMatchObject({ c: 1 });

    // 完全相同的重抽 → 幂等跳过
    const again = ingestExtractions(tmp.db, cid, ext, "v1", audit);
    expect(again.skipped).toBe(1);
    expect(tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals").get()).toMatchObject({ c: 1 });

    // 同源新事实 → 旧行 superseded，新行顶上
    const changed = [{ ...ext[0]!, content: "咨询商业下午茶，改问下半年场次" }];
    const third = ingestExtractions(tmp.db, cid, changed, "v1", audit);
    expect(third.inserted).toBe(1);
    expect(third.superseded).toBe(1);
    const rows = tmp.sqlite
      .prepare("SELECT superseded_by FROM customer_signals ORDER BY id")
      .all() as { superseded_by: number | null }[];
    expect(rows[0]!.superseded_by).not.toBeNull();
    expect(rows[1]!.superseded_by).toBeNull();
  });

  it("跨来源同 type+topic 且 90 天内 → 合并 mention_count+1，不新增行；超 90 天 → 新行", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "陈小姐");
    await createRecord(admin.cookie, cid, { kind: "note", happenedAt: clock.t - 10 * DAY, content: "a" });
    await createRecord(admin.cookie, cid, { kind: "note", happenedAt: clock.t - 10 * DAY, content: "b" });
    const ids = (tmp.sqlite
      .prepare("SELECT id FROM customer_maintenance_records WHERE customer_id=? ORDER BY id")
      .all(cid) as { id: number }[]).map((r) => r.id);

    const audit = { now: clock.t, userId: admin.id };
    ingestExtractions(tmp.db, cid, [
      { type: "supply", topic: "小红书运营", content: "经营小红书代运营工作室", confidence: 0.8, sourceType: "maintenance_record", sourceId: ids[0]!, sourceAt: clock.t - 10 * DAY },
    ], "v1", audit);
    const merged = ingestExtractions(tmp.db, cid, [
      { type: "supply", topic: "小红书运营", content: "经营小红书代运营工作室（再次提及）", confidence: 0.85, sourceType: "maintenance_record", sourceId: ids[1]!, sourceAt: clock.t - 12 * DAY },
    ], "v1", audit);
    expect(merged.merged).toBe(1);
    expect(merged.inserted).toBe(0);
    const row = tmp.sqlite.prepare("SELECT mention_count, content FROM customer_signals").get() as { mention_count: number; content: string };
    expect(row.mention_count).toBe(2);
    expect(row.content).toContain("再次提及");

    // 半年前的同主题 → 独立新行（时间序列）
    const old = ingestExtractions(tmp.db, cid, [
      { type: "supply", topic: "小红书运营", content: "早年也做过代运营", confidence: 0.7, sourceType: "maintenance_record", sourceId: ids[1]!, sourceAt: clock.t - 200 * DAY },
    ], "v1", audit);
    expect(old.inserted).toBe(1);
  });

  it("TTL：intent 90 天过期 → active=false 仍可见且 status=expired；growth 永不过期", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "李总");
    await createRecord(admin.cookie, cid, { kind: "note", happenedAt: clock.t - 100 * DAY, content: "x" });
    const recId = (tmp.sqlite.prepare("SELECT id FROM customer_maintenance_records WHERE customer_id=?").get(cid) as { id: number }).id;
    const audit = { now: clock.t, userId: admin.id };
    ingestExtractions(tmp.db, cid, [
      { type: "intent", topic: "私董", content: "对私董有意向", confidence: 0.9, sourceType: "maintenance_record", sourceId: recId, sourceAt: clock.t - 100 * DAY },
      { type: "growth", topic: "门店扩张", content: "二店开业", confidence: 0.9, sourceType: "maintenance_record", sourceId: recId, sourceAt: clock.t - 100 * DAY },
    ], "v1", audit);

    const active = await get(`/api/v1/insights/signals?customerId=${cid}`, admin.cookie);
    expect(active.statusCode).toBe(200);
    expect(active.json().data).toHaveLength(1); // intent 已过期
    expect(active.json().data[0].type).toBe("growth");

    const all = await get(`/api/v1/insights/signals?customerId=${cid}&active=false`, admin.cookie);
    expect(all.json().data).toHaveLength(2);
    const expired = all.json().data.find((s: { type: string }) => s.type === "intent");
    expect(expired.status).toBe("expired");
  });
});

// ── REST：RBAC + pivot + depth + 人工补录/否决 + 词表 ──

describe("insights REST", () => {
  it("RBAC：assistant 全部 403；未登录 401；operator 200", async () => {
    const admin = await loginAsRole("admin");
    await createCustomer(admin.cookie, "客户A");
    const op = await loginAsRole("operator");
    const asst = await loginAsRole("assistant");

    expect((await get("/api/v1/insights/pivot", op.cookie)).statusCode).toBe(200);
    expect((await get("/api/v1/insights/pivot", asst.cookie)).statusCode).toBe(403);
    expect((await get("/api/v1/insights/pivot", "")).statusCode).toBe(401);
    expect((await get("/api/v1/insights/signals", asst.cookie)).statusCode).toBe(403);
    expect((await get("/api/v1/insights/topics", asst.cookie)).statusCode).toBe(403);
  });

  it("pivot：默认 city × stageTag；带 calibre meta；非法轴 422；ownerId 过滤", async () => {
    const admin = await loginAsRole("admin");
    const op = await loginAsRole("operator");
    const tagRes = await post("/api/v1/tags", admin.cookie, { name: "意向客户", scope: "stage" });
    expect(tagRes.statusCode).toBe(201);
    const tagId = tagRes.json().data.id;
    const c1 = await createCustomer(admin.cookie, "上海创业者", { city: "上海", tagIds: [tagId] });
    await createCustomer(admin.cookie, "成都主理人", { city: "成都", ownerId: admin.id });
    // 上海客户一条 lead 记录（温度事件）
    await createRecord(admin.cookie, c1, { kind: "lead", happenedAt: clock.t, content: "咨询" });

    const res = await get("/api/v1/insights/pivot", admin.cookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.calibre.temperature.halfLifeDays).toBe(TEMPERATURE.halfLifeDays);
    expect(body.data.total).toBe(2);
    // 默认 x=city（列）、y=stageTag（行）
    expect(body.data.columns.some((c: { x: string }) => c.x === "上海")).toBe(true);
    const intentRow = body.data.rows.find((r: { y: string }) => r.y === "意向客户");
    expect(intentRow).toBeTruthy();
    expect(intentRow.cells.find((c: { x: string }) => c.x === "上海").count).toBe(1);
    expect(body.data.rows.some((r: { y: string }) => r.y === "未打标")).toBe(true);

    // 非法轴
    expect((await get("/api/v1/insights/pivot?x=nope", admin.cookie)).statusCode).toBe(422);

    // ownerId 过滤
    const filtered = await get(`/api/v1/insights/pivot?ownerId=${admin.id}`, admin.cookie);
    expect(filtered.json().data.total).toBe(1);
    expect(filtered.json().data.rows[0].cells.some((c: { count: number }) => c.count === 1)).toBe(true);
    void op;
  });

  it("pivot：temperatureBand × valueBand 维度与成交金额联动", async () => {
    const admin = await loginAsRole("admin");
    const c1 = await createCustomer(admin.cookie, "金主", { city: "上海" });
    const prodRes = await post("/api/v1/products", admin.cookie, { name: "咨询年卡", productType: "c_consulting", priceCents: 2_000_000 });
    expect(prodRes.statusCode).toBe(201);
    await createDeal(admin.cookie, { customerId: c1, productId: prodRes.json().data.id, stage: "paid", dealDate: clock.t - 5 * DAY, amountCents: 2_000_000 });
    await createRecord(admin.cookie, c1, { kind: "follow_up", happenedAt: clock.t - 2 * DAY, content: "回访" });

    const res = await get("/api/v1/insights/pivot?x=valueBand&y=temperatureBand", admin.cookie);
    const rows = res.json().data.rows as { y: string; cells: { x: string; count: number }[] }[];
    const hotRow = rows.find((r) => r.y.includes("活跃"));
    expect(hotRow).toBeTruthy();
    expect(hotRow!.cells.some((c) => c.x === "1-5 万" && c.count === 1)).toBe(true);
  });

  it("depth：温度/序列/信号/404", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "深潜客户");
    await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: clock.t - 1 * DAY, content: "咨询产品" });

    const ok = await get(`/api/v1/insights/customers/${cid}/depth`, admin.cookie);
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.data.temperature).toBeGreaterThan(30);
    expect(body.data.temperatureSeries).toHaveLength(13);
    expect(body.data.customer.nickname).toBe("深潜客户");
    expect(body.meta.calibre).toBeTruthy();

    expect((await get("/api/v1/insights/customers/999999/depth", admin.cookie)).statusCode).toBe(404);
  });

  it("人工补录 + 否决；补录建词免审批", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "补录客户");
    const created = await post("/api/v1/insights/signals", admin.cookie, {
      customerId: cid,
      type: "need",
      topic: "直播带货",
      content: "在找直播代播团队",
    });
    expect(created.statusCode).toBe(201);
    const dto = created.json().data;
    expect(dto.status).toBe("active");
    expect(dto.confidence).toBe(1);
    expect(dto.sourceType).toBe("manual");

    // 词表免审批直接可查
    const topics = await get("/api/v1/insights/topics", admin.cookie);
    expect(topics.json().data.some((t: { name: string }) => t.name === "直播带货")).toBe(true);

    const rejected = await post(`/api/v1/insights/signals/${dto.id}/reject`, admin.cookie, {});
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().data.status).toBe("rejected");

    // assistant 不可写
    const asst = await loginAsRole("assistant");
    expect((await post("/api/v1/insights/signals", asst.cookie, { customerId: cid, type: "need", content: "x" })).statusCode).toBe(403);
  });

  it("词表合并：信号改指 + related 边迁移 + 旧词软删 + 自并自 422", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "合并客户");
    // 建两个词 + 一条信号挂在待并词上
    const a = await post("/api/v1/insights/signals", admin.cookie, { customerId: cid, type: "need", topic: "小红书代运营", content: "找代运营" });
    expect(a.statusCode).toBe(201);
    await post("/api/v1/insights/signals", admin.cookie, { customerId: cid, type: "supply", topic: "小红书运营", content: "做代运营" });
    const topics = (await get("/api/v1/insights/topics", admin.cookie)).json().data as { id: number; name: string; signalCount: number }[];
    const from = topics.find((t) => t.name === "小红书代运营")!;
    const into = topics.find((t) => t.name === "小红书运营")!;

    const merged = await post(`/api/v1/insights/topics/${from.id}/merge`, admin.cookie, { intoId: into.id });
    expect(merged.statusCode).toBe(200);

    const after = (await get("/api/v1/insights/topics?pageSize=100", admin.cookie)).json().data as { name: string; signalCount: number }[];
    expect(after.some((t) => t.name === "小红书代运营")).toBe(false);
    const intoRow = after.find((t) => t.name === "小红书运营")!;
    expect(intoRow.signalCount).toBe(2);

    const self = await post(`/api/v1/insights/topics/${into.id}/merge`, admin.cookie, { intoId: into.id });
    expect(self.statusCode).toBe(422);
  });
});

// ── 抽取任务（LLM mock + 种子 + 入队钩子） ──

describe("signal.extract 抽取任务", () => {
  it("词表种子：兴趣标签 + 产品名预热；已有词则跳过", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    await post("/api/v1/tags", admin.cookie, { name: "小红书", scope: "interest" });
    await post("/api/v1/products", admin.cookie, { name: "商业下午茶", productType: "campaign" });
    await createCustomer(admin.cookie, "种子客户");

    await extractCustomerSignals(tmp.db, 1, { now: clock.t, userId: admin.id }, llmOk({ signals: [] }));
    const names = (tmp.sqlite.prepare("SELECT name FROM signal_topics WHERE deleted_at IS NULL").all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain("小红书");
    expect(names).toContain("商业下午茶");
  });

  it("单客户抽取：LLM 输出落库（含新词 + nearest related 边）；重复抽取幂等", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "王总", { originStory: "李姐介绍来，做手工饰品电商" });
    await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: clock.t - 3 * DAY, content: "想做小红书但团队没人懂，问有没有资源介绍" });

    const mock = llmOk({
      signals: [
        { type: "need", topic: "小红书运营", topicNearest: "小红书", content: "找小红书运营资源，团队无人懂", confidence: 0.9, sourceIndex: 1 },
      ],
    });
    // 先种一个词给 nearest 用
    await post("/api/v1/tags", admin.cookie, { name: "小红书", scope: "interest" });
    const result = await extractCustomerSignals(tmp.db, cid, { now: clock.t, userId: admin.id }, mock);
    expect(result.extracted).toBe(1);
    expect(result.inserted).toBe(1);

    const row = tmp.sqlite.prepare("SELECT * FROM customer_signals").get() as { type: string; content: string; topic_id: number; source_type: string };
    expect(row.type).toBe("need");
    expect(row.source_type).toBe("maintenance_record");
    // nearest 边
    const rel = tmp.sqlite.prepare("SELECT COUNT(*) c FROM signal_topic_relations WHERE source='llm'").get() as { c: number };
    expect(rel.c).toBe(1);

    // 幂等重跑（同 mock）→ skipped
    const again = await extractCustomerSignals(tmp.db, cid, { now: clock.t, userId: admin.id }, mock);
    expect(again.skipped).toBe(1);
    expect(again.inserted).toBe(0);
  });

  it("记录删除后重抽：来源已消失的信号被软删（cleaned）", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "删除客户");
    const rec = await createRecord(admin.cookie, cid, { kind: "note", happenedAt: clock.t, content: "刚在杭州开了第二家店" });
    const mock = llmOk({
      signals: [{ type: "growth", content: "杭州二店开业", confidence: 0.9, sourceIndex: 0 }],
    });
    await extractCustomerSignals(tmp.db, cid, { now: clock.t, userId: admin.id }, mock);
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals WHERE deleted_at IS NULL").get() as { c: number }).c).toBe(1);

    // 软删记录 → 重抽（bundle 为空则只走清理路径：再补一条记录保底）
    tmp.sqlite.prepare("UPDATE customer_maintenance_records SET deleted_at=? WHERE id=?").run(clock.t, rec.id);
    const cleaned = await extractCustomerSignals(tmp.db, cid, { now: clock.t, userId: admin.id }, llmOk({ signals: [] }));
    expect(cleaned.cleaned).toBe(1);
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM customer_signals WHERE deleted_at IS NULL").get() as { c: number }).c).toBe(0);
  });

  it("记录 REST 落库入队：LLM 已配置 → background_jobs 出现 insights-signal-extract；未配置 → 不入队且记录正常", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "入队客户");

    // 未配置 LLM：记录 201、无队列行
    const r1 = await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: clock.t, content: "x" });
    expect(r1.id).toBeGreaterThan(0);
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM background_jobs WHERE type='insights-signal-extract'").get() as { c: number }).c).toBe(0);

    seedAiConfigRow();
    await createRecord(admin.cookie, cid, { kind: "follow_up", happenedAt: clock.t, content: "y" });
    expect((tmp.sqlite.prepare("SELECT COUNT(*) c FROM background_jobs WHERE type='insights-signal-extract'").get() as { c: number }).c).toBe(1);
  });

  it("任务注册表：validate 未配 LLM → 创建 422；运行扫尾模式处理 stale 客户", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "扫尾客户");
    await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: clock.t, content: "想了解私董" });

    // 未配置 LLM → validate 抛 422
    expect(() =>
      JOB_TYPES["insights-signal-extract"]!.validate!(tmp.db, {}),
    ).toThrowError(/请先在「系统设置」配置 LLM/);

    seedAiConfigRow();
    const finished: { status?: string; result?: unknown } = {};
    const ctx = {
      db: tmp.db,
      jobId: 1,
      audit: { now: clock.t, userId: admin.id },
      fetchFn: llmOk({ signals: [{ type: "intent", topic: "私董", content: "想了解私董", confidence: 0.8, sourceIndex: 0 }] }),
      isCancelled: () => false,
      reportProgress: () => {},
      finish: (status: string, payload: { result?: unknown }) => {
        finished.status = status;
        finished.result = payload.result;
      },
    };
    await JOB_TYPES["insights-signal-extract"]!.run(ctx as never, {});
    expect(finished.status).toBe("succeeded");
    const result = finished.result as { total: number; succeeded: number };
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect((tmp.sqlite.prepare("SELECT type FROM customer_signals").get() as { type: string }).type).toBe("intent");
  });

  it("runSignalExtractJob：单客户失败（LLM 500）→ partial，其余继续", async () => {
    seedAiConfigRow();
    const admin = await loginAsRole("admin");
    const c1 = await createCustomer(admin.cookie, "好客户");
    const c2 = await createCustomer(admin.cookie, "坏客户");
    await createRecord(admin.cookie, c1, { kind: "note", happenedAt: clock.t, content: "正常文本" });
    await createRecord(admin.cookie, c2, { kind: "note", happenedAt: clock.t, content: "炸掉文本" });

    const failFor: Record<number, string> = { [c2]: "炸掉" };
    const condFetch = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
      const body = String(init?.body ?? "");
      for (const marker of Object.values(failFor)) {
        if (body.includes(marker)) return new Response("upstream boom", { status: 500 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ signals: [] }) } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await runSignalExtractJob(
      tmp.db,
      { all: true },
      { now: clock.t, userId: admin.id },
      { fetchFn: condFetch, isCancelled: () => false, onProgress: () => {} },
    );
    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures[0]!.customerId).toBe(c2);
  });
});
