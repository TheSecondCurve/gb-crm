// K62 三期 缘分清单：两级召回（exact 满分 / 1-hop related ×0.7）+ 加成（同城/共同交付/反复提及）+
// 护栏（自匹配排除 / confidence 门槛 / 未过期 risk 隔离）+ 主题聚合凑桌结论。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMatchPairs, type MatchSignalRow } from "../../src/modules/insights/match.js";
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

// ── 纯函数单测 ──

const signal = (over: Partial<MatchSignalRow> & { customerId: number; nickname: string; topicId: number }): MatchSignalRow => ({
  id: over.id ?? 1,
  city: null,
  topicName: null,
  content: "…",
  mentionCount: 1,
  confidence: 0.9,
  sourceAt: 1,
  ...over,
} as MatchSignalRow);

describe("buildMatchPairs 纯函数", () => {
  const membership = new Map<number, Set<number>>([
    [1, new Set([10, 11])],
    [2, new Set([11])],
    [3, new Set([99])],
  ]);

  it("exact 满基础分；同城 +2；共同交付 +2 排序在前", () => {
    const pairs = buildMatchPairs(
      [signal({ customerId: 1, nickname: "王总", topicId: 5, topicName: "小红书运营", city: "上海" })],
      [
        signal({ customerId: 2, nickname: "陈小姐", topicId: 5, topicName: "小红书运营", city: "上海" }),
        signal({ customerId: 3, nickname: "李总", topicId: 5, topicName: "小红书运营", city: "成都" }),
      ],
      [],
      membership,
      new Set<number>(),
    );
    expect(pairs).toHaveLength(2);
    const top = pairs[0]!;
    expect(top.supplyNickname).toBe("陈小姐");
    expect(top.score).toBeCloseTo(1 + 2 + 2, 5); // base + 同城 + 共同交付
    expect(pairs[1]!.score).toBe(1);
    expect(pairs[1]!.sameCity).toBe(false);
  });

  it("1-hop related 命中打 0.7 折并标记 viaRelated", () => {
    const pairs = buildMatchPairs(
      [signal({ customerId: 1, nickname: "王总", topicId: 5, topicName: "小红书运营" })],
      [signal({ customerId: 3, nickname: "李总", topicId: 7, topicName: "小红书代运营" })],
      [{ topicId: 5, relatedTopicId: 7 }],
      new Map(),
      new Set<number>(),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.viaRelated).toBe(true);
    expect(pairs[0]!.score).toBeCloseTo(0.7, 5);
  });

  it("护栏：自匹配排除、confidence 低于 0.6 不参与、risk 客户隔离", () => {
    const pairs = buildMatchPairs(
      [
        signal({ customerId: 1, nickname: "王总", topicId: 5 }),
        signal({ customerId: 2, nickname: "低置信需求", topicId: 5, confidence: 0.3 }),
        signal({ customerId: 4, nickname: "风险需求", topicId: 5 }),
      ],
      [
        signal({ customerId: 1, nickname: "王总自己", topicId: 5 }),
        signal({ customerId: 3, nickname: "低置信供给", topicId: 5, confidence: 0.5 }),
        signal({ customerId: 5, nickname: "供给", topicId: 5 }),
        signal({ customerId: 6, nickname: "风险供给", topicId: 5 }),
      ],
      [],
      new Map(),
      new Set([4, 6]),
    );
    // 唯一合法配对：王总(1) × 供给(5)；自匹配(1×1)、低置信(2/3)、风险(4/6) 全被拦
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!).toMatchObject({ needCustomerId: 1, supplyCustomerId: 5 });
  });
});

// ── 端点 ──

async function loginAsRole(role: "admin" | "assistant", username = `u-${role}`): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

describe("GET /insights/match", () => {
  it("need × supply 配对 + related 召回 + 主题聚合结论；assistant 403", async () => {
    const admin = await loginAsRole("admin");
    // 词：小红书运营(1) + 小红书代运营(2)，LLM related 边
    const wang = (await app.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: admin.cookie }, payload: { nickname: "王总", city: "上海" } })).json().data.id;
    const chen = (await app.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: admin.cookie }, payload: { nickname: "陈小姐", city: "上海" } })).json().data.id;
    await app.inject({ method: "POST", url: "/api/v1/insights/signals", headers: { cookie: admin.cookie }, payload: { customerId: wang, type: "need", topic: "小红书运营", content: "找小红书运营资源" } });
    await app.inject({ method: "POST", url: "/api/v1/insights/signals", headers: { cookie: admin.cookie }, payload: { customerId: chen, type: "supply", topic: "小红书代运营", content: "开代运营工作室" } });
    // 手工补 related 边（模拟 LLM nearest）：直接插 relation
    const t1 = (tmp.sqlite.prepare("SELECT id FROM signal_topics WHERE name='小红书运营'").get() as { id: number }).id;
    const t2 = (tmp.sqlite.prepare("SELECT id FROM signal_topics WHERE name='小红书代运营'").get() as { id: number }).id;
    tmp.sqlite
      .prepare("INSERT INTO signal_topic_relations (topic_id, related_topic_id, source, created_at) VALUES (?,?, 'admin', ?)")
      .run(t1, t2, clock.t);

    const res = await app.inject({ method: "GET", url: "/api/v1/insights/match", headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.total).toBe(1);
    expect(data.pairs[0]).toMatchObject({ needNickname: "王总", supplyNickname: "陈小姐", viaRelated: true, sameCity: true });
    expect(data.pairs[0].score).toBeGreaterThanOrEqual(0.7 + 2);
    expect(data.conclusion).toContain("凑一桌条件成熟");
    expect(res.json().meta.calibre.match.relatedDiscount).toBe(0.7);

    const asst = await loginAsRole("assistant");
    expect((await app.inject({ method: "GET", url: "/api/v1/insights/match", headers: { cookie: asst.cookie } })).statusCode).toBe(403);
  });
});
