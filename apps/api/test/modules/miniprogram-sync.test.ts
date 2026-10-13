// 小程序客户同步任务（type=miniprogram-users-sync，K64）：
// CRM 侧拉取小程序后端 /agent/sql 的 users 增量，upsert 进 customers。
// - 匹配顺序：wechat_openid → phone 精确（链接老客户）→ 新建；
// - 低风险纪律：只新建 + 只填空，永不覆盖人工维护值；软删客户不复活；
// - 水印 (updated_at, id) 增量推进，批提交后落 system_configs，失败续跑幂等。
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import {
  channels,
  customerMaintenanceRecords,
  customers,
  customerSourceChannels,
  customerTags,
  systemConfigs,
  tags,
} from "../../src/db/schema.js";
import { createJobRunner } from "../../src/modules/jobs/runner.js";
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

// ---- 夹具 ----

const SOURCE_COLUMNS = ["id", "openid", "nickname", "phone", "created_at", "updated_at"];

/** 造一行小程序 users 表行（数组形态，对齐 columns 顺序；id/count 为 int8 → string） */
function mpRow(
  id: number,
  overrides: {
    openid?: string | null;
    nickname?: string | null;
    phone?: string | null;
    created_at?: string;
    updated_at?: string;
  } = {},
): unknown[] {
  return [
    String(id),
    overrides.openid === undefined ? `openid-${id}` : overrides.openid,
    overrides.nickname === undefined ? `小程序昵称${id}` : overrides.nickname,
    overrides.phone === undefined ? null : overrides.phone,
    overrides.created_at ?? "2026-01-01T08:00:00.000Z",
    overrides.updated_at ?? "2026-06-01T08:00:00.000Z",
  ];
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 小程序后端 /agent/sql mock：count 查询回批次数总和，批次查询按队列出队；记录每条 SQL */
function backendMock(batches: unknown[][][], opts: { status?: number; errorMessage?: string } = {}) {
  const calls: string[] = [];
  let batchIdx = 0;
  const fetchFn = vi.fn(async (_url: unknown, init?: unknown) => {
    const sqlText = String(JSON.parse(String((init as RequestInit).body)).sql);
    calls.push(sqlText);
    if (opts.status !== undefined) {
      return jsonRes({ error: { code: "X", message: opts.errorMessage ?? "denied" } }, opts.status);
    }
    if (/count\(/i.test(sqlText)) {
      const total = batches.reduce((n, b) => n + b.length, 0);
      return jsonRes({ columns: ["n"], rows: [[String(total)]], rowCount: 1, truncated: false });
    }
    const batch = batches[batchIdx] ?? [];
    batchIdx += 1;
    return jsonRes({
      columns: SOURCE_COLUMNS,
      rows: batch,
      rowCount: batch.length,
      truncated: false,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function seedChannelRow(db: Db, name: string, deletedAt: number | null = null): number {
  return Number(
    db
      .insert(channels)
      .values({ name, createdAt: clock.t, updatedAt: clock.t, deletedAt })
      .run().lastInsertRowid,
  );
}

function seedTagRow(db: Db, name: string, deletedAt: number | null = null): number {
  return Number(
    db
      .insert(tags)
      .values({
        name,
        domain: "customer",
        scope: "other",
        sort: 0,
        enabled: 1,
        createdAt: clock.t,
        updatedAt: clock.t,
        deletedAt,
      })
      .run().lastInsertRowid,
  );
}

interface SyncSeed {
  channelId: number;
  tagId: number;
}

/** 种同步配置（system_configs code='miniprogramSync'）；渠道/标签复用同名 live 行，配置行按 code upsert */
function seedSyncConfig(db: Db, overrides: Record<string, unknown> = {}): SyncSeed {
  const existingChannel = db
    .select()
    .from(channels)
    .where(eq(channels.name, "女商小程序"))
    .get();
  const channelId = existingChannel?.id ?? seedChannelRow(db, "女商小程序");
  const existingTag = db.select().from(tags).where(eq(tags.name, "小程序用户")).get();
  const tagId = existingTag?.id ?? seedTagRow(db, "小程序用户");
  db.insert(systemConfigs)
    .values({
      code: "miniprogramSync",
      value: JSON.stringify({
        enabled: true,
        baseUrl: "https://mp.example.com",
        token: "mp-read-pat",
        channelId,
        tagId,
        watermark: { updatedAtMs: 0, lastId: 0 },
        ...overrides,
      }),
      updatedAt: clock.t,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: systemConfigs.code,
      set: {
        value: JSON.stringify({
          enabled: true,
          baseUrl: "https://mp.example.com",
          token: "mp-read-pat",
          channelId,
          tagId,
          watermark: { updatedAtMs: 0, lastId: 0 },
          ...overrides,
        }),
        updatedAt: clock.t,
        updatedBy: null,
      },
    })
    .run();
  return { channelId, tagId };
}

function readSyncConfig(db: Db): Record<string, unknown> {
  const row = db.select().from(systemConfigs).where(eq(systemConfigs.code, "miniprogramSync")).get();
  return JSON.parse(row!.value) as Record<string, unknown>;
}

async function loginAsRole(role: "admin" | "operator" | "assistant") {
  const username = `u-${role}`;
  await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  return loginAs(app, username, "password123");
}

const post = (url: string, cookie: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const get = (url: string, cookie: string) => app.inject({ method: "GET", url, headers: { cookie } });

interface SyncJobDto {
  status: string;
  typeLabel: string;
  error: string | null;
  result: {
    total: number;
    scanned: number;
    created: number;
    linked: number;
    filled: number;
    skippedDeleted: number;
    failed: number;
    failures: { userId: number | null; openid: string | null; message: string }[];
    watermark: { updatedAtMs: number; lastId: number };
    cancelled: boolean;
  } | null;
}

async function runSyncJob(
  cookie: string,
  opts: { fetchFn?: typeof fetch; params?: Record<string, unknown> } = {},
): Promise<SyncJobDto> {
  const res = await post("/api/v1/background-jobs", cookie, {
    type: "miniprogram-users-sync",
    ...(opts.params ? { params: opts.params } : {}),
  });
  expect(res.statusCode).toBe(201);
  const jobId = res.json().data.id as number;
  const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn: opts.fetchFn });
  await runner.pumpOnce();
  const detail = await get(`/api/v1/background-jobs/${jobId}`, cookie);
  return detail.json().data as SyncJobDto;
}

const allCustomers = () => tmp.db.select().from(customers).all();

// ---- 创建闸 ----

describe("小程序客户同步 · 创建闸", () => {
  it("assistant → 403；operator / admin → 201", async () => {
    seedSyncConfig(tmp.db);
    const assistant = await loginAsRole("assistant");
    expect(
      (await post("/api/v1/background-jobs", assistant, { type: "miniprogram-users-sync" }))
        .statusCode,
    ).toBe(403);
    const operator = await loginAsRole("operator");
    expect(
      (await post("/api/v1/background-jobs", operator, { type: "miniprogram-users-sync" }))
        .statusCode,
    ).toBe(201);
    const admin = await loginAsRole("admin");
    expect(
      (await post("/api/v1/background-jobs", admin, { type: "miniprogram-users-sync" }))
        .statusCode,
    ).toBe(201);
  });

  it("未配置同步配置 → 422；enabled=false / 缺 token → 422；渠道或标签失效 → 422", async () => {
    const admin = await loginAsRole("admin");
    const create = () => post("/api/v1/background-jobs", admin, { type: "miniprogram-users-sync" });

    // 完全未配置
    let res = await create();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("小程序同步");

    // enabled=false
    seedSyncConfig(tmp.db, { enabled: false });
    expect((await create()).statusCode).toBe(422);

    // 缺 token
    seedSyncConfig(tmp.db, { enabled: true, token: "" });
    expect((await create()).statusCode).toBe(422);

    // 渠道已软删
    const deadChannel = seedChannelRow(tmp.db, "已删渠道", clock.t);
    seedSyncConfig(tmp.db, { enabled: true, channelId: deadChannel });
    res = await create();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("渠道");

    // 标签已软删
    const deadTag = seedTagRow(tmp.db, "已删标签", clock.t);
    seedSyncConfig(tmp.db, { enabled: true, tagId: deadTag });
    res = await create();
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("标签");

    // 配置完好 → 201
    seedSyncConfig(tmp.db);
    expect((await create()).statusCode).toBe(201);
  });

  it("params 严格校验：未知键 422", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");
    const res = await post("/api/v1/background-jobs", admin, {
      type: "miniprogram-users-sync",
      params: { full: true, hacker: 1 },
    });
    expect(res.statusCode).toBe(422);
  });
});

// ---- 同步执行 ----

describe("小程序客户同步 · 执行", () => {
  it("全量回填：新建客户字段映射 + 来源渠道 + 标签 + lead 记录 + 水印推进", async () => {
    const { channelId, tagId } = seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");
    const { fetchFn } = backendMock([
      [
        mpRow(1, { nickname: "小明", phone: "13800000001" }),
        mpRow(2, { nickname: "小红", phone: null }),
      ],
    ]);

    const dto = await runSyncJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.typeLabel).toBe("小程序客户同步");
    expect(dto.result).toMatchObject({
      total: 2,
      scanned: 2,
      created: 2,
      linked: 0,
      failed: 0,
      cancelled: false,
    });

    const rows = allCustomers();
    expect(rows).toHaveLength(2);
    const c1 = rows.find((r) => r.wechatOpenid === "openid-1")!;
    expect(c1.nickname).toBe("小明");
    expect(c1.phone).toBe("13800000001");
    expect(c1.customerType).toBe("customer");
    expect(c1.ownerId).toBeNull();
    // 审计语义：created_at = 同步时刻，不是注册时间
    expect(c1.createdAt).toBe(clock.t);
    const c2 = rows.find((r) => r.wechatOpenid === "openid-2")!;
    expect(c2.phone).toBeNull();

    // 来源渠道 + 标签
    for (const c of [c1, c2]) {
      expect(
        tmp.db
          .select()
          .from(customerSourceChannels)
          .where(eq(customerSourceChannels.customerId, c.id))
          .all()
          .map((r) => r.channelId),
      ).toEqual([channelId]);
      expect(
        tmp.db
          .select()
          .from(customerTags)
          .where(eq(customerTags.customerId, c.id))
          .all()
          .map((r) => r.tagId),
      ).toEqual([tagId]);
    }

    // lead 维护记录：happened_at = 小程序注册时间
    const leads = tmp.db.select().from(customerMaintenanceRecords).all();
    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      customerId: c1.id,
      kind: "lead",
      happenedAt: new Date("2026-01-01T08:00:00.000Z").getTime(),
    });
    expect(leads[0]!.content).toContain("小程序");

    // 水印推进到最后一行并落库
    const wm = readSyncConfig(tmp.db).watermark as { updatedAtMs: number; lastId: number };
    expect(wm).toEqual({
      updatedAtMs: new Date("2026-06-01T08:00:00.000Z").getTime(),
      lastId: 2,
    });
    expect(dto.result!.watermark).toEqual(wm);
  });

  it("昵称空 → 兜底「小程序用户<id>」；手机号空白串归一为 null", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");
    const { fetchFn } = backendMock([[mpRow(7, { nickname: "  ", phone: "  " })]]);

    const dto = await runSyncJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    const c = allCustomers()[0]!;
    expect(c.nickname).toBe("小程序用户7");
    expect(c.phone).toBeNull();
  });

  it("已有 openid 客户：人工昵称/手机不被覆盖；CRM 手机空则回填；渠道标签幂等", async () => {
    const { channelId } = seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");

    // 已链接客户：人工改过昵称与手机
    tmp.db
      .insert(customers)
      .values({
        nickname: "张总（人工）",
        phone: "13900000000",
        wechatOpenid: "openid-1",
        customerType: "customer",
        createdAt: clock.t,
        updatedAt: clock.t,
      })
      .run();
    // 已链接客户：手机空待回填
    tmp.db
      .insert(customers)
      .values({
        nickname: "李姐",
        phone: null,
        wechatOpenid: "openid-2",
        customerType: "customer",
        createdAt: clock.t,
        updatedAt: clock.t,
      })
      .run();

    const { fetchFn } = backendMock([
      [
        mpRow(1, { nickname: "新昵称", phone: "13800000001" }),
        mpRow(2, { nickname: "李姐小程序", phone: "13800000002" }),
        mpRow(2, { nickname: "李姐小程序", phone: "13800000002" }), // 同批重复行 → 幂等
      ],
    ]);
    const dto = await runSyncJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result).toMatchObject({ scanned: 3, created: 0, linked: 0, filled: 1 });

    const rows = allCustomers();
    expect(rows).toHaveLength(2);
    const c1 = rows.find((r) => r.wechatOpenid === "openid-1")!;
    expect(c1.nickname).toBe("张总（人工）");
    expect(c1.phone).toBe("13900000000");
    const c2 = rows.find((r) => r.wechatOpenid === "openid-2")!;
    expect(c2.nickname).toBe("李姐");
    expect(c2.phone).toBe("13800000002");

    // 重复行不重复挂渠道
    expect(
      tmp.db
        .select()
        .from(customerSourceChannels)
        .where(eq(customerSourceChannels.customerId, c2.id))
        .all()
        .filter((r) => r.channelId === channelId),
    ).toHaveLength(1);
  });

  it("phone 精确匹配老客 → 链接回填 openid，不新建；无 phone 且无 openid 匹配才新建", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");

    // 线下老客：只有手机，无 openid
    const existingId = Number(
      tmp.db
        .insert(customers)
        .values({
          nickname: "线下老客王总",
          phone: "13800000001",
          customerType: "customer",
          createdAt: clock.t,
          updatedAt: clock.t,
        })
        .run().lastInsertRowid,
    );

    const { fetchFn } = backendMock([
      [
        mpRow(1, { openid: "openid-new-1", nickname: "王总小程序", phone: "13800000001" }),
        mpRow(2, { openid: "openid-new-2", nickname: "全新用户", phone: "13700000000" }),
      ],
    ]);
    const dto = await runSyncJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result).toMatchObject({ created: 1, linked: 1 });

    const rows = allCustomers();
    expect(rows).toHaveLength(2);
    const linked = rows.find((r) => r.id === existingId)!;
    expect(linked.wechatOpenid).toBe("openid-new-1");
    expect(linked.nickname).toBe("线下老客王总"); // 人工昵称不动
    const created = rows.find((r) => r.wechatOpenid === "openid-new-2")!;
    expect(created.phone).toBe("13700000000");
  });

  it("软删客户含同 openid → 跳过不复活、不新建", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");
    tmp.db
      .insert(customers)
      .values({
        nickname: "已删客户",
        wechatOpenid: "openid-dead",
        customerType: "customer",
        createdAt: clock.t,
        updatedAt: clock.t,
        deletedAt: clock.t,
      })
      .run();

    const { fetchFn } = backendMock([[mpRow(9, { openid: "openid-dead" })]]);
    const dto = await runSyncJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result).toMatchObject({ scanned: 1, created: 0, skippedDeleted: 1 });
    // 没有新建 live 行，软删行原样
    expect(allCustomers()).toHaveLength(1);
    expect(allCustomers()[0]!.deletedAt).not.toBeNull();
  });

  it("增量：第二跑 SQL 带推进后的水印章；空批零处理", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");

    const first = backendMock([[mpRow(1), mpRow(2)]]);
    await runSyncJob(admin, { fetchFn: first.fetchFn });
    expect(allCustomers()).toHaveLength(2);

    const second = backendMock([[]]);
    const dto = await runSyncJob(admin, { fetchFn: second.fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result).toMatchObject({ total: 0, scanned: 0, created: 0 });
    // 第二跑 count=0 → 不再拉批次；水印条件体现在 count 查询里（updated_at 界 + id tiebreak）
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]).toContain("to_timestamp(");
    expect(second.calls[0]).toContain("id > 2");
    expect(allCustomers()).toHaveLength(2);
  });

  it("翻页：满批继续拉取直至未满批终止", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");
    const full = Array.from({ length: 500 }, (_, i) => mpRow(i + 1));
    const tail = [mpRow(501)];
    const { calls, fetchFn } = backendMock([full, tail]);

    const dto = await runSyncJob(admin, { fetchFn });
    expect(dto.status).toBe("succeeded");
    expect(dto.result).toMatchObject({ total: 501, scanned: 501, created: 501 });
    // count 一次 + 两批（第二批 1 行 < 500 → 终止，不多拉）
    expect(calls).toHaveLength(3);
    expect(allCustomers()).toHaveLength(501);
  });

  it("full=true 重置水印重扫，已链接行幂等不重复建", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");

    const first = backendMock([[mpRow(1), mpRow(2)]]);
    await runSyncJob(admin, { fetchFn: first.fetchFn });

    const second = backendMock([[mpRow(1), mpRow(2), mpRow(3)]]);
    const dto = await runSyncJob(admin, { fetchFn: second.fetchFn, params: { full: true } });
    expect(dto.status).toBe("succeeded");
    expect(dto.result).toMatchObject({ scanned: 3, created: 1 });
    expect(allCustomers()).toHaveLength(3);
    // 全量重扫的 SQL 从零点水印出发
    const batchSql = second.calls.find((s) => !/count\(/i.test(s))!;
    expect(batchSql).toContain("to_timestamp(0");
    expect(batchSql).toContain("id > 0");
  });

  it("远端 401 → failed + 中文指引；500 → failed；网络异常 → failed；不产生脏数据", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");

    const unauthorized = backendMock([], { status: 401 });
    let dto = await runSyncJob(admin, { fetchFn: unauthorized.fetchFn });
    expect(dto.status).toBe("failed");
    expect(dto.error).toContain("401");

    const serverError = backendMock([], { status: 500, errorMessage: "boom" });
    dto = await runSyncJob(admin, { fetchFn: serverError.fetchFn });
    expect(dto.status).toBe("failed");
    expect(dto.error).toContain("500");

    const networkDown = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    dto = await runSyncJob(admin, { fetchFn: networkDown });
    expect(dto.status).toBe("failed");
    expect(dto.error).toContain("ECONNREFUSED");

    expect(allCustomers()).toHaveLength(0);
  });

  it("运行期间配置被移除 → failed（先建任务再删配置，runner 兜底中文错误）", async () => {
    seedSyncConfig(tmp.db);
    const admin = await loginAsRole("admin");
    const res = await post("/api/v1/background-jobs", admin, { type: "miniprogram-users-sync" });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().data.id as number;

    // 排队期间配置被清空
    tmp.db.delete(systemConfigs).where(eq(systemConfigs.code, "miniprogramSync")).run();

    const { fetchFn } = backendMock([[mpRow(1)]]);
    const runner = createJobRunner({ db: tmp.db, now: () => clock.t, fetchFn });
    await runner.pumpOnce();
    const detail = await get(`/api/v1/background-jobs/${jobId}`, admin);
    expect(detail.json().data.status).toBe("failed");
    expect(detail.json().data.error).toContain("小程序同步");
    expect(allCustomers()).toHaveLength(0);
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
