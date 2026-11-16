// K68 语料同步端点：/api/v1/corpus/documents（文本类语料变更流，含墓碑）+ /head 水位探针 +
// /documents/:id 单条补拉。授权：corpus 专用 scope PAT（永不过期、只放行语料端点），
// 或任意可读 materials 的身份（read PAT / cookie）。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const get = (url: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url, headers });

type JsonBody = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Material = any;

/** 签发 corpus 令牌（须先 seedUser alice）；返回明文与库内行 id */
async function mintCorpus(): Promise<{ token: string; rowId: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/tokens",
    payload: { username: "alice", password: "password123", scope: "corpus", name: "外部大脑" },
  });
  expect(res.statusCode).toBe(201);
  const data = res.json().data as { token: string; prefix: string };
  const row = tmp.sqlite
    .prepare("SELECT id FROM api_tokens WHERE token_prefix = ?")
    .get(data.prefix) as { id: number };
  return { token: data.token, rowId: row.id };
}

async function createMaterial(cookie: string, payload: JsonBody): Promise<Material> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/materials",
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

/** 标准语料种子：甲(transcript,t0) 乙(text,+1s,挂标签) 丙(audio,+2s,语料域外) */
async function seed() {
  await seedUser(tmp.db);
  const cookie = await loginAs(app, "alice", "password123");
  const a = await createMaterial(cookie, {
    kind: "transcript",
    title: "私董会转写甲",
    content: "甲的全文内容。",
  });
  const tA = a.updatedAt as number;
  clock.t += 1000;
  const tag = (
    await app.inject({
      method: "POST",
      url: "/api/v1/tags",
      headers: { cookie },
      payload: { name: "高价值", domain: "material" },
    })
  ).json().data as { id: number };
  const b = await createMaterial(cookie, {
    kind: "text",
    title: "文案乙",
    content: "乙的全文内容，关键词蓝山。",
    tagIds: [tag.id],
  });
  const tB = b.updatedAt as number;
  clock.t += 1000;
  const c = await createMaterial(cookie, {
    kind: "audio",
    title: "录音丙",
    url: "https://example.com/c.mp3",
  });
  const { token } = await mintCorpus();
  return { cookie, a, b, c, tA, tB, token };
}

describe("corpus scope 令牌（K68）", () => {
  it("签发：gbcrm_co_ 前缀、expiresAt null、库内 expires_at 为 NULL", async () => {
    await seedUser(tmp.db);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tokens",
      payload: { username: "alice", password: "password123", scope: "corpus" },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { token: string; prefix: string; expiresAt: number | null };
    expect(data.token).toMatch(/^gbcrm_co_[0-9a-f]{64}$/);
    expect(data.prefix).toBe(data.token.slice(0, 17));
    expect(data.expiresAt).toBeNull();
    const row = tmp.sqlite
      .prepare("SELECT scope, expires_at FROM api_tokens WHERE token_prefix = ?")
      .get(data.prefix) as { scope: string; expires_at: number | null };
    expect(row).toEqual({ scope: "corpus", expires_at: null });
  });

  it("只放行语料端点：documents/head/:id 200，其余 API 403", async () => {
    const s = await seed();
    expect((await get("/api/v1/corpus/documents", bearer(s.token))).statusCode).toBe(200);
    expect((await get("/api/v1/corpus/head", bearer(s.token))).statusCode).toBe(200);
    expect((await get(`/api/v1/corpus/documents/${s.a.id}`, bearer(s.token))).statusCode).toBe(200);

    for (const url of ["/api/v1/customers", "/api/v1/materials", "/api/v1/users"]) {
      const res = await get(url, bearer(s.token));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toContain("语料");
    }
    const sql = await app.inject({
      method: "POST",
      url: "/api/v1/agent/sql",
      headers: bearer(s.token),
      payload: { sql: "SELECT 1" },
    });
    expect(sql.statusCode).toBe(403);
  });

  it("永不过期：时钟推进 10 年仍可用；read 令牌同期已 401", async () => {
    const s = await seed();
    const read = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/tokens",
        payload: { username: "alice", password: "password123", scope: "read" },
      })
    ).json().data as { token: string };

    clock.t += 10 * 365 * 24 * 60 * 60 * 1000;
    expect((await get("/api/v1/corpus/head", bearer(s.token))).statusCode).toBe(200);
    expect((await get("/api/v1/materials", bearer(read.token))).statusCode).toBe(401);
  });

  it("吊销（admin）与自撤销后立即 401", async () => {
    await seedUser(tmp.db);
    const first = await mintCorpus();
    const admin = await loginAs(app, "alice", "password123");
    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/admin/${first.rowId}`,
      headers: { cookie: admin },
    });
    expect(revoke.statusCode).toBe(204);
    expect((await get("/api/v1/corpus/head", bearer(first.token))).statusCode).toBe(401);

    // 自撤销：corpus 允许的唯一写路径
    const again = await mintCorpus();
    const selfRevoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/tokens/${again.rowId}`,
      headers: bearer(again.token),
    });
    expect(selfRevoke.statusCode).toBe(204);
    expect((await get("/api/v1/corpus/head", bearer(again.token))).statusCode).toBe(401);
  });

  it("read PAT 与 assistant cookie 也能访问；未认证 401", async () => {
    await seedUser(tmp.db);
    await seedUser(tmp.db, { username: "assist", systemRole: "assistant" });
    const read = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/tokens",
        payload: { username: "assist", password: "password123", scope: "read" },
      })
    ).json().data as { token: string };

    expect((await get("/api/v1/corpus/documents", bearer(read.token))).statusCode).toBe(200);
    const cookie = await loginAs(app, "assist", "password123");
    expect((await get("/api/v1/corpus/documents", { cookie })).statusCode).toBe(200);
    expect((await get("/api/v1/corpus/documents", {})).statusCode).toBe(401);
  });
});

describe("GET /api/v1/corpus/documents", () => {
  it("全量：只含 transcript/text、updatedAt 升序；content 缺省 null；audio 排除", async () => {
    const s = await seed();
    const res = await get("/api/v1/corpus/documents", bearer(s.token));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((d: Material) => [d.id, d.kind])).toEqual([
      [s.a.id, "transcript"],
      [s.b.id, "text"],
    ]);
    expect(body.data.every((d: Material) => d.deleted === false)).toBe(true);
    expect(body.data[0].content).toBeNull();
    expect(body.data[0].contentLength).toBe("甲的全文内容。".length);
    expect(body.meta).toMatchObject({ page: 1, pageSize: 25, total: 2, nextSince: s.tB });
  });

  it("updatedSince 严格大于；空页 nextSince null", async () => {
    const s = await seed();
    const since = await get(`/api/v1/corpus/documents?updatedSince=${s.tB}`, bearer(s.token));
    expect(since.json().data).toEqual([]);
    expect(since.json().meta.nextSince).toBeNull();

    const before = await get(`/api/v1/corpus/documents?updatedSince=${s.tA}`, bearer(s.token));
    expect(before.json().data.map((d: Material) => d.id)).toEqual([s.b.id]);
  });

  it("墓碑：删除后进增量流（deleted:true），内容过滤不影响墓碑", async () => {
    const s = await seed();
    clock.t += 2000; // 删除时刻
    const del = await app.inject({
      method: "DELETE",
      url: `/api/v1/materials/${s.a.id}`,
      headers: { cookie: s.cookie },
    });
    expect(del.statusCode).toBe(204);

    const res = await get(`/api/v1/corpus/documents?updatedSince=${s.tB}`, bearer(s.token));
    expect(res.json().data).toEqual([{ id: s.a.id, deleted: true, updatedAt: clock.t }]);

    // q=蓝山 只匹配乙，但墓碑仍须出现（删除事实不能被过滤器吞掉）
    const filtered = await get(
      `/api/v1/corpus/documents?updatedSince=${s.tB}&q=${encodeURIComponent("蓝山")}`,
      bearer(s.token),
    );
    expect(filtered.json().data.map((d: Material) => d.id)).toEqual([s.a.id]);
  });

  it("include=content 带全文；pageSize 上限 25", async () => {
    const s = await seed();
    const res = await get("/api/v1/corpus/documents?include=content", bearer(s.token));
    expect(res.json().data[0].content).toBe("甲的全文内容。");

    const over = await get("/api/v1/corpus/documents?include=content&pageSize=26", bearer(s.token));
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe("VALIDATION");
    const ok = await get("/api/v1/corpus/documents?include=content&pageSize=25", bearer(s.token));
    expect(ok.statusCode).toBe(200);
  });

  it("q 与 tagNames 过滤 live 行", async () => {
    const s = await seed();
    const byQ = await get(
      `/api/v1/corpus/documents?q=${encodeURIComponent("蓝山")}`,
      bearer(s.token),
    );
    expect(byQ.json().data.map((d: Material) => d.id)).toEqual([s.b.id]);

    const byTag = await get(
      `/api/v1/corpus/documents?tagNames=${encodeURIComponent("高价值")}`,
      bearer(s.token),
    );
    expect(byTag.json().data.map((d: Material) => d.id)).toEqual([s.b.id]);

    const miss = await get(
      `/api/v1/corpus/documents?tagNames=${encodeURIComponent("不存在的词")}`,
      bearer(s.token),
    );
    expect(miss.json().data).toEqual([]);
    expect(miss.json().meta.total).toBe(0);
  });

  it("分页：pageSize=1 时两页各一行，meta 带总数", async () => {
    const s = await seed();
    const page1 = await get("/api/v1/corpus/documents?page=1&pageSize=1", bearer(s.token));
    const page2 = await get("/api/v1/corpus/documents?page=2&pageSize=1", bearer(s.token));
    expect(page1.json().data.map((d: Material) => d.id)).toEqual([s.a.id]);
    expect(page2.json().data.map((d: Material) => d.id)).toEqual([s.b.id]);
    expect(page2.json().meta).toMatchObject({ page: 2, pageSize: 1, total: 2 });
  });
});

describe("GET /api/v1/corpus/documents/:id", () => {
  it("文本类带全文；音频类 / 已删 → 404", async () => {
    const s = await seed();
    const ok = await get(`/api/v1/corpus/documents/${s.b.id}`, bearer(s.token));
    expect(ok.json().data).toMatchObject({ id: s.b.id, kind: "text", content: "乙的全文内容，关键词蓝山。" });
    expect((await get(`/api/v1/corpus/documents/${s.c.id}`, bearer(s.token))).statusCode).toBe(404);

    clock.t += 1000;
    await app.inject({
      method: "DELETE",
      url: `/api/v1/materials/${s.b.id}`,
      headers: { cookie: s.cookie },
    });
    expect((await get(`/api/v1/corpus/documents/${s.b.id}`, bearer(s.token))).statusCode).toBe(404);
  });
});

describe("GET /api/v1/corpus/head", () => {
  it("空库：latestUpdatedAt null、liveDocuments 0", async () => {
    await seedUser(tmp.db);
    const { token } = await mintCorpus();
    const res = await get("/api/v1/corpus/head", bearer(token));
    expect(res.json().data).toEqual({ latestUpdatedAt: null, liveDocuments: 0 });
  });

  it("latestUpdatedAt 含已删行（墓碑推进前沿）；liveDocuments 只数 live 文本类", async () => {
    const s = await seed();
    clock.t += 5000;
    await app.inject({
      method: "DELETE",
      url: `/api/v1/materials/${s.a.id}`,
      headers: { cookie: s.cookie },
    });
    const res = await get("/api/v1/corpus/head", bearer(s.token));
    expect(res.json().data).toEqual({ latestUpdatedAt: clock.t, liveDocuments: 1 });
  });
});
