// payout-batches（K59）：payout 结算批次——自动纳入 / 候选 / 明细增删 / 状态机（lock/unlock/mark-paid）
// / 快照语义 / RBAC / 导出 xlsx。inject + loginAs，假时钟控时间戳；payout 数据走 PUT /deals/:id/payouts。
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { splitPayoutAmount } from "@gb-crm/shared";

import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { customers, products } from "../../src/db/schema.js";
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

type JsonBody = Record<string, unknown>;

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const put = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PUT", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) =>
  app.inject({ method: "DELETE", url, headers: { cookie } });

let seq = 0;
async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username?: string,
): Promise<{ id: number; cookie: string }> {
  const uname = username ?? `u-${role}-${seq++}`;
  const id = await seedUser(tmp.db, { username: uname, systemRole: role, nickname: `昵称-${uname}` });
  const cookie = await loginAs(app, uname, "password123");
  return { id, cookie };
}

function seedCustomer(db: Db, nickname: string, extra: JsonBody = {}): number {
  const now = clock.t;
  return Number(
    db
      .insert(customers)
      .values({ nickname, createdAt: now, updatedAt: now, ...extra } as never)
      .run().lastInsertRowid,
  );
}

function seedProduct(db: Db, name: string): number {
  const now = clock.t;
  return Number(db.insert(products).values({ name, createdAt: now, updatedAt: now }).run().lastInsertRowid);
}

const D = (month: number, day: number) => Date.UTC(2026, month, day, 12); // 正午 UTC，避开时区日界

interface DealOpts {
  customerId?: number;
  customerOwnerId?: number;
  ownerId?: number;
  productId?: number;
  dealDate?: number;
  payouts?: { seq: 1 | 2; payoutDate: number; rate: number }[];
}

/** 建一笔金额 100000 / 税后 0.9 / 总比例 0.1（分红池 9000）的成交，并按需 PUT payouts */
async function makeDeal(cookie: string, opts: DealOpts = {}): Promise<number> {
  const customerId =
    opts.customerId ??
    seedCustomer(tmp.db, `客户-${seq++}`, {
      ...(opts.customerOwnerId !== undefined ? { ownerId: opts.customerOwnerId } : {}),
    });
  const res = await post("/api/v1/deals", cookie, {
    customerId,
    dealDate: opts.dealDate ?? D(5, 15),
    amountCents: 100000,
    afterTaxRatio: 0.9,
    ...(opts.productId !== undefined ? { productId: opts.productId } : {}),
    ...(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
  });
  expect(res.statusCode).toBe(201);
  const deal = res.json().data;
  const patched = await patch(`/api/v1/deals/${deal.id}`, cookie, {
    commissionRatio: 0.1,
    updatedAt: deal.updatedAt,
  });
  expect(patched.statusCode).toBe(200);
  if (opts.payouts && opts.payouts.length > 0) {
    const putRes = await put(`/api/v1/deals/${deal.id}/payouts`, cookie, { payouts: opts.payouts });
    expect(putRes.statusCode).toBe(200);
  }
  return deal.id;
}

/** 默认方案：dealOwner 0.6 / owner 0.4（分红池 9000 → 期 rate 1 = 9000 → 5400/3600） */
async function setDefaultScheme(cookie: string): Promise<void> {
  const res = await patch("/api/v1/system/commission-default", cookie, {
    totalRatio: 0.1,
    rules: [
      { source: "dealOwner", percentage: 0.6 },
      { source: "owner", percentage: 0.4 },
    ],
  });
  expect(res.statusCode).toBe(200);
}

const RANGE = { startDate: D(6, 1), endDate: D(6, 31) };

describe("POST /payout-batches 创建自动纳入", () => {
  it("范围内 + pending + 未占用 → 纳入；范围外/已 paid 排除；name 缺省生成", async () => {
    const { cookie } = await loginAsRole("admin");
    const inRange = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(7, 10), rate: 1 }] }); // 范围外
    const paidDeal = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 12), rate: 1 }] });
    await patch(`/api/v1/deals/${paidDeal}/payouts/1`, cookie, { status: "paid" }); // 已 paid

    const res = await post("/api/v1/payout-batches", cookie, RANGE);
    expect(res.statusCode).toBe(201);
    const detail = res.json().data;
    expect(detail.batch.name).toBe("发放 2026-07-01~2026-07-31");
    expect(detail.batch.status).toBe("draft");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0].dealId).toBe(inRange);
    expect(detail.items[0].payoutAmountCents).toBe(9000);
    expect(detail.items[0].payoutStatus).toBe("pending");
    expect(detail.items[0].stale).toBe(false);
    expect(detail.batch.itemCount).toBe(1);
    expect(detail.batch.totalAmountCents).toBe(9000);

    // 自定义名称
    const named = await post("/api/v1/payout-batches", cookie, { ...RANGE, name: "七月第一批" });
    expect(named.statusCode).toBe(201);
    expect(named.json().data.batch.name).toBe("七月第一批");

    // startDate > endDate → 422
    expect(
      (await post("/api/v1/payout-batches", cookie, { startDate: D(6, 31), endDate: D(6, 1) }))
        .statusCode,
    ).toBe(422);
  });

  it("第二个重叠范围批次不重复纳入已被占用的 payout", async () => {
    const { cookie } = await loginAsRole("admin");
    await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });

    const first = await post("/api/v1/payout-batches", cookie, RANGE);
    expect(first.json().data.items).toHaveLength(1);

    const second = await post("/api/v1/payout-batches", cookie, RANGE);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.items).toHaveLength(0);

    // 第一批次删除（draft）后释放占用，再建可纳入
    await del(`/api/v1/payout-batches/${first.json().data.batch.id}`, cookie);
    const third = await post("/api/v1/payout-batches", cookie, RANGE);
    expect(third.json().data.items).toHaveLength(1);
  });
});

describe("GET /payout-batches 列表", () => {
  it("分页 + status 筛选 + itemCount/totalAmountCents（draft 实时 sum）", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: creatorId, cookie: c } = await loginAsRole("admin", "admin-list2");
    await makeDeal(c, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 0.5 }] });
    await makeDeal(c, { payouts: [{ seq: 1, payoutDate: D(6, 11), rate: 0.5 }] });
    const created = await post("/api/v1/payout-batches", c, { ...RANGE, name: "批次A" });
    const batchId = created.json().data.batch.id;

    const list = await get("/api/v1/payout-batches", cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json().meta).toMatchObject({ page: 1, pageSize: 25, total: 1 });
    const row = list.json().data[0];
    expect(row).toMatchObject({
      id: batchId,
      name: "批次A",
      status: "draft",
      itemCount: 2,
      totalAmountCents: 9000,
      rangeStart: RANGE.startDate,
      rangeEnd: RANGE.endDate,
    });
    expect(row.createdBy.id).toBe(creatorId);

    // locked 批次用快照 sum：锁定后改底层金额不影响
    await post(`/api/v1/payout-batches/${batchId}/lock`, c);
    const lockedList = await get("/api/v1/payout-batches?status=locked", cookie);
    expect(lockedList.json().meta.total).toBe(1);
    expect(lockedList.json().data[0].totalAmountCents).toBe(9000);
    const draftList = await get("/api/v1/payout-batches?status=draft", cookie);
    expect(draftList.json().meta.total).toBe(0);
  });
});

describe("GET /payout-batches/candidates", () => {
  it("只列 pending、日期过滤、activeBatchId 标注、shares 预览、按 payoutDate 升序", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: ownerId } = await loginAsRole("operator", "owner-cand");
    const { id: dealOwnerId } = await loginAsRole("operator", "dealowner-cand");
    await setDefaultScheme(cookie);

    const later = await makeDeal(cookie, {
      ownerId: dealOwnerId,
      customerOwnerId: ownerId,
      payouts: [{ seq: 1, payoutDate: D(6, 20), rate: 1 }],
    });
    const earlier = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 5), rate: 1 }] });
    const paid = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 8), rate: 1 }] });
    await patch(`/api/v1/deals/${paid}/payouts/1`, cookie, { status: "paid" });

    // 占位批次只圈 later（D(6,15)~D(6,31)），earlier 保持未占用
    await post("/api/v1/payout-batches", cookie, {
      startDate: D(6, 15),
      endDate: D(6, 31),
      name: "占位批次",
    });

    const res = await get("/api/v1/payout-batches/candidates", cookie);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.map((c: { dealId: number }) => c.dealId)).toEqual([earlier, later]); // 升序、paid 排除
    expect(data[0].activeBatchId).toBeNull();
    expect(data[1].activeBatchId).not.toBeNull();
    expect(data[1].activeBatchName).toBe("占位批次");
    // shares 预览 = splitPayoutAmount × 当前分成解析（默认方案 dealOwner 0.6 / owner 0.4）
    expect(data[1].shares).toEqual([
      { userId: dealOwnerId, nickname: "昵称-dealowner-cand", amountCents: 5400 },
      { userId: ownerId, nickname: "昵称-owner-cand", amountCents: 3600 },
    ]);
    expect(data[1].dealMonth).toBe("2026-06");

    // 日期过滤
    const ranged = await get(
      `/api/v1/payout-batches/candidates?startDate=${D(6, 15)}&endDate=${D(6, 31)}`,
      cookie,
    );
    expect(ranged.json().data.map((c: { dealId: number }) => c.dealId)).toEqual([later]);
  });
});

describe("批次明细增删（仅 draft）", () => {
  async function setup() {
    const { cookie } = await loginAsRole("admin");
    const dealIn = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const dealOut = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(7, 10), rate: 1 }] });
    const created = await post("/api/v1/payout-batches", cookie, RANGE);
    const batch = created.json().data.batch;
    return { cookie, dealIn, dealOut, batch };
  }

  it("添加：404 payout 不存在 / 409 已 paid / 409 已在本批次 / 409 已在其它活跃批次（带 details）", async () => {
    const { cookie, dealIn, dealOut, batch } = await setup();

    // payout 不存在 → 404
    expect(
      (await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, { dealId: dealOut, seq: 2 }))
        .statusCode,
    ).toBe(404);

    // 已在本批次 → 409
    expect(
      (await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, { dealId: dealIn, seq: 1 }))
        .statusCode,
    ).toBe(409);

    // 添加范围外 pending payout → 200 返回完整详情
    const added = await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, {
      dealId: dealOut,
      seq: 1,
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().data.items).toHaveLength(2);

    // 已 paid → 409
    const paidDeal = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 15), rate: 1 }] });
    await patch(`/api/v1/deals/${paidDeal}/payouts/1`, cookie, { status: "paid" });
    expect(
      (await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, { dealId: paidDeal, seq: 1 }))
        .statusCode,
    ).toBe(409);

    // 已在其它 draft 批次 → 409 带批次信息
    const other = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 20), rate: 1 }] });
    const otherBatch = (
      await post("/api/v1/payout-batches", cookie, { startDate: D(6, 16), endDate: D(6, 30), name: "批次B" })
    ).json().data.batch;
    const dup = await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, {
      dealId: other,
      seq: 1,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details).toEqual({ batchId: otherBatch.id, batchName: "批次B" });

    // 批次不存在 → 404
    expect(
      (await post("/api/v1/payout-batches/99999/items", cookie, { dealId: dealOut, seq: 1 }))
        .statusCode,
    ).toBe(404);
  });

  it("移除：成功返回详情；跨批次 itemId → 404；非 draft 批次写操作 → 409", async () => {
    const { cookie, dealOut, batch } = await setup();
    const added = await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, {
      dealId: dealOut,
      seq: 1,
    });
    const itemId = added.json().data.items.find((i: { dealId: number }) => i.dealId === dealOut).id;

    const removed = await del(`/api/v1/payout-batches/${batch.id}/items/${itemId}`, cookie);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.items).toHaveLength(1);

    // 跨批次 / 不存在 itemId → 404
    expect((await del(`/api/v1/payout-batches/${batch.id}/items/${itemId}`, cookie)).statusCode).toBe(404);
    expect((await del(`/api/v1/payout-batches/${batch.id}/items/99999`, cookie)).statusCode).toBe(404);

    // 锁定后增删 → 409
    await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie);
    expect(
      (await post(`/api/v1/payout-batches/${batch.id}/items`, cookie, { dealId: dealOut, seq: 1 }))
        .statusCode,
    ).toBe(409);
    const lockedItemId = (await get(`/api/v1/payout-batches/${batch.id}`, cookie)).json().data
      .items[0].id;
    expect((await del(`/api/v1/payout-batches/${batch.id}/items/${lockedItemId}`, cookie)).statusCode).toBe(409);
  });
});

describe("PATCH/DELETE 批次（仅 draft）", () => {
  it("改名；空 PATCH → 422；locked → 409；删除硬删级联；不存在 → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const batch = (await post("/api/v1/payout-batches", cookie, RANGE)).json().data.batch;

    const renamed = await patch(`/api/v1/payout-batches/${batch.id}`, cookie, { name: "新名字" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.batch.name).toBe("新名字");

    expect((await patch(`/api/v1/payout-batches/${batch.id}`, cookie, {})).statusCode).toBe(422);
    expect((await patch("/api/v1/payout-batches/99999", cookie, { name: "x" })).statusCode).toBe(404);

    await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie);
    expect((await patch(`/api/v1/payout-batches/${batch.id}`, cookie, { name: "y" })).statusCode).toBe(409);
    expect((await del(`/api/v1/payout-batches/${batch.id}`, cookie)).statusCode).toBe(409);

    // 解锁回 draft 后可删；硬删级联明细
    await post(`/api/v1/payout-batches/${batch.id}/unlock`, cookie);
    expect((await del(`/api/v1/payout-batches/${batch.id}`, cookie)).statusCode).toBe(204);
    const items = tmp.sqlite
      .prepare("SELECT COUNT(*) n FROM payout_batch_items WHERE batch_id = ?")
      .get(batch.id) as { n: number };
    expect(items.n).toBe(0);
    expect((await del(`/api/v1/payout-batches/${batch.id}`, cookie)).statusCode).toBe(404);
  });
});

describe("lock/unlock 快照语义", () => {
  async function setupWithScheme() {
    const { cookie } = await loginAsRole("admin");
    const { id: ownerId } = await loginAsRole("operator", "owner-lock");
    const { id: dealOwnerId } = await loginAsRole("operator", "dealowner-lock");
    await setDefaultScheme(cookie);
    const productId = seedProduct(tmp.db, "产品-锁定");
    const dealId = await makeDeal(cookie, {
      ownerId: dealOwnerId,
      customerOwnerId: ownerId,
      productId,
      payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }],
    });
    const batch = (await post("/api/v1/payout-batches", cookie, RANGE)).json().data.batch;
    return { cookie, ownerId, dealOwnerId, dealId, batch };
  }

  it("锁定物化快照 + shares；lock 后改底层 payout/分成不影响批次；unlock 回到实时", async () => {
    const { cookie, ownerId, dealOwnerId, dealId, batch } = await setupWithScheme();

    const locked = await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie);
    expect(locked.statusCode).toBe(200);
    const detail = locked.json().data;
    expect(detail.batch.status).toBe("locked");
    expect(detail.batch.lockedAt).toBe(clock.t);
    expect(detail.items[0].payoutAmountCents).toBe(9000);
    expect(detail.items[0].shares).toEqual([
      { userId: dealOwnerId, nickname: "昵称-dealowner-lock", amountCents: 5400 },
      { userId: ownerId, nickname: "昵称-owner-lock", amountCents: 3600 },
    ]);
    expect(detail.items[0].product).toEqual({ id: expect.any(Number), name: "产品-锁定" });
    expect(detail.summary).toHaveLength(2);
    expect(detail.summary[0]).toMatchObject({ userId: dealOwnerId, totalAmountCents: 5400 });

    // 快照已物化
    const snap = tmp.sqlite
      .prepare("SELECT amount_cents, payout_date, rate FROM payout_batch_items WHERE batch_id = ?")
      .get(batch.id) as { amount_cents: number | null; payout_date: number | null; rate: number | null };
    expect(snap.amount_cents).toBe(9000);
    expect(snap.payout_date).toBe(D(6, 10));
    expect(snap.rate).toBe(1);
    const shareRows = tmp.sqlite
      .prepare(
        "SELECT s.user_id, s.amount_cents FROM payout_batch_item_shares s JOIN payout_batch_items i ON i.id = s.item_id WHERE i.batch_id = ? ORDER BY s.user_id",
      )
      .all(batch.id) as { user_id: number; amount_cents: number }[];
    expect(shareRows).toEqual([
      { user_id: ownerId, amount_cents: 3600 },
      { user_id: dealOwnerId, amount_cents: 5400 },
    ]);

    // 改底层：PUT 替换 payout（rate 0.5 → 金额 4500）+ 改分成配置 → 批次仍返回快照
    await put(`/api/v1/deals/${dealId}/payouts`, cookie, {
      payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 0.5 }],
    });
    await put(`/api/v1/deals/${dealId}/commissions`, cookie, {
      items: [{ userId: dealOwnerId, percentage: 1 }],
    });
    const after = (await get(`/api/v1/payout-batches/${batch.id}`, cookie)).json().data;
    expect(after.items[0].payoutAmountCents).toBe(9000);
    expect(after.items[0].rate).toBe(1);
    expect(after.items[0].shares.map((s: { amountCents: number }) => s.amountCents)).toEqual([5400, 3600]);
    expect(after.items[0].payoutStatus).toBe("pending");
    expect(after.items[0].stale).toBe(false);

    // unlock → 快照清空、shares 删除，详情回到实时（rate 0.5 → 4500，新分成 1.0 → 9000 全归 dealOwner）
    const unlocked = await post(`/api/v1/payout-batches/${batch.id}/unlock`, cookie);
    expect(unlocked.statusCode).toBe(200);
    const live = unlocked.json().data;
    expect(live.batch.status).toBe("draft");
    expect(live.batch.lockedAt).toBeNull();
    expect(live.items[0].payoutAmountCents).toBe(4500);
    expect(live.items[0].shares).toEqual([
      { userId: dealOwnerId, nickname: "昵称-dealowner-lock", amountCents: 4500 },
    ]);
    const cleared = tmp.sqlite
      .prepare("SELECT amount_cents FROM payout_batch_items WHERE batch_id = ?")
      .get(batch.id) as { amount_cents: number | null };
    expect(cleared.amount_cents).toBeNull();
    const shareCount = tmp.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM payout_batch_item_shares s JOIN payout_batch_items i ON i.id = s.item_id WHERE i.batch_id = ?",
      )
      .get(batch.id) as { n: number };
    expect(shareCount.n).toBe(0);
  });

  it("stale 明细（底层被冲掉/已 paid）→ lock 422 带 details.staleItems", async () => {
    const { cookie } = await loginAsRole("admin");
    const missingDeal = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const paidDeal = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 11), rate: 1 }] });
    const batch = (await post("/api/v1/payout-batches", cookie, RANGE)).json().data.batch;

    // 底层 payout 被 PUT 清空（missing）+ 另一条被单独标记已发（paid）
    await put(`/api/v1/deals/${missingDeal}/payouts`, cookie, { payouts: [] });
    await patch(`/api/v1/deals/${paidDeal}/payouts/1`, cookie, { status: "paid" });

    // draft 详情实时展示 stale
    const live = (await get(`/api/v1/payout-batches/${batch.id}`, cookie)).json().data;
    expect(live.items.map((i: { payoutStatus: string }) => i.payoutStatus)).toEqual(["missing", "paid"]);
    expect(live.items.every((i: { stale: boolean }) => i.stale)).toBe(true);

    const res = await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
    expect(res.json().error.details.staleItems).toEqual([
      { itemId: live.items[0].id, dealId: missingDeal, seq: 1, reason: "missing" },
      { itemId: live.items[1].id, dealId: paidDeal, seq: 1, reason: "paid" },
    ]);

    // 移除 stale 明细后可锁定
    await del(`/api/v1/payout-batches/${batch.id}/items/${live.items[0].id}`, cookie);
    await del(`/api/v1/payout-batches/${batch.id}/items/${live.items[1].id}`, cookie);
    expect((await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie)).statusCode).toBe(200);
  });
});

describe("mark-paid 与状态机", () => {
  it("locked → mark-paid：底层 payout 置 paid+paid_at、批次 paid、meta marked/skipped；重复 → 409", async () => {
    const { cookie } = await loginAsRole("admin");
    const d1 = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const d2 = await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 11), rate: 1 }] });
    const batch = (await post("/api/v1/payout-batches", cookie, RANGE)).json().data.batch;

    // d2 在锁定前被单独标记已发 → mark-paid 时 skipped
    await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie);
    await patch(`/api/v1/deals/${d2}/payouts/1`, cookie, { status: "paid" });

    const res = await post(`/api/v1/payout-batches/${batch.id}/mark-paid`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toEqual({ marked: 1, skipped: 1 });
    const detail = res.json().data;
    expect(detail.batch.status).toBe("paid");
    expect(detail.batch.paidAt).toBe(clock.t);

    const p1 = (await get(`/api/v1/deals/${d1}/payouts`, cookie)).json().data;
    expect(p1[0]).toMatchObject({ status: "paid", paidAt: clock.t });

    // paid 批次仍展示快照；payoutStatus 实时（paid 是预期终态，stale=false）
    expect(detail.items[0].payoutStatus).toBe("paid");
    expect(detail.items.every((i: { stale: boolean }) => !i.stale)).toBe(true);

    // 重复 mark-paid / paid 后 unlock → 409
    expect((await post(`/api/v1/payout-batches/${batch.id}/mark-paid`, cookie)).statusCode).toBe(409);
    expect((await post(`/api/v1/payout-batches/${batch.id}/unlock`, cookie)).statusCode).toBe(409);
    expect((await del(`/api/v1/payout-batches/${batch.id}`, cookie)).statusCode).toBe(409);
  });

  it("非法迁移：draft 直接 mark-paid / draft unlock / paid lock → 409", async () => {
    const { cookie } = await loginAsRole("admin");
    await makeDeal(cookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const batch = (await post("/api/v1/payout-batches", cookie, RANGE)).json().data.batch;

    expect((await post(`/api/v1/payout-batches/${batch.id}/mark-paid`, cookie)).statusCode).toBe(409);
    expect((await post(`/api/v1/payout-batches/${batch.id}/unlock`, cookie)).statusCode).toBe(409);
    expect((await post("/api/v1/payout-batches/99999/lock", cookie)).statusCode).toBe(404);
  });
});

describe("RBAC（复用 dealCommissions 资源）", () => {
  it("assistant：list/read/candidates/export 200；写操作全部 403", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    await makeDeal(adminCookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const batch = (await post("/api/v1/payout-batches", adminCookie, RANGE)).json().data.batch;
    const { cookie: aCookie } = await loginAsRole("assistant");

    expect((await get("/api/v1/payout-batches", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/payout-batches/${batch.id}`, aCookie)).statusCode).toBe(200);
    expect((await get("/api/v1/payout-batches/candidates", aCookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/payout-batches/${batch.id}/export.xlsx`, aCookie)).statusCode).toBe(200);

    expect((await post("/api/v1/payout-batches", aCookie, RANGE)).statusCode).toBe(403);
    expect((await patch(`/api/v1/payout-batches/${batch.id}`, aCookie, { name: "x" })).statusCode).toBe(403);
    expect((await del(`/api/v1/payout-batches/${batch.id}`, aCookie)).statusCode).toBe(403);
    expect((await post(`/api/v1/payout-batches/${batch.id}/lock`, aCookie)).statusCode).toBe(403);
  });

  it("operator：写操作 200", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    await makeDeal(adminCookie, { payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 1 }] });
    const { cookie: opCookie } = await loginAsRole("operator");
    const res = await post("/api/v1/payout-batches", opCookie, RANGE);
    expect(res.statusCode).toBe(201);
    const batchId = res.json().data.batch.id;
    expect((await post(`/api/v1/payout-batches/${batchId}/lock`, opCookie)).statusCode).toBe(200);
  });
});

describe("GET /payout-batches/:id/export.xlsx", () => {
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  async function loadWb(buf: Buffer): Promise<ExcelJS.Workbook> {
    const wb = new ExcelJS.Workbook();
    // exceljs 的 load 声明引用旧版 @types/node 的 Buffer，与现版泛型 Buffer 不兼容，收窄断言
    await wb.xlsx.load(buf as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0]);
    return wb;
  }

  it("两 sheet：发放汇总（参与人×月份 pivot + 总计）金额与 splitPayoutAmount 一致；发放明细长表", async () => {
    const { cookie } = await loginAsRole("admin");
    const { id: ownerId } = await loginAsRole("operator", "owner-exp");
    const { id: dealOwnerId } = await loginAsRole("operator", "dealowner-exp");
    await setDefaultScheme(cookie);
    const productId = seedProduct(tmp.db, "产品-导出");

    // 两个月各一笔（6 月成交 4500 期、7 月成交 9000 期）
    await makeDeal(cookie, {
      ownerId: dealOwnerId,
      customerOwnerId: ownerId,
      productId,
      dealDate: D(5, 15), // 上海墙钟 2026-06
      payouts: [{ seq: 1, payoutDate: D(6, 10), rate: 0.5 }],
    });
    await makeDeal(cookie, {
      ownerId: dealOwnerId,
      customerOwnerId: ownerId,
      dealDate: D(6, 15), // 上海墙钟 2026-07
      payouts: [{ seq: 1, payoutDate: D(6, 20), rate: 1 }],
    });
    const batch = (
      await post("/api/v1/payout-batches", cookie, { ...RANGE, name: "导出批次" })
    ).json().data.batch;
    await post(`/api/v1/payout-batches/${batch.id}/lock`, cookie);

    const res = await get(`/api/v1/payout-batches/${batch.id}/export.xlsx`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(XLSX_MIME);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(decodeURIComponent(res.headers["content-disposition"] as string)).toContain(
      "分成发放-导出批次.xlsx",
    );

    const wb = await loadWb(res.rawPayload);
    const summarySheet = wb.getWorksheet("发放汇总");
    const detailSheet = wb.getWorksheet("发放明细");
    expect(summarySheet).toBeDefined();
    expect(detailSheet).toBeDefined();

    const splits = [
      { userId: dealOwnerId, percentage: 0.6 },
      { userId: ownerId, percentage: 0.4 },
    ];
    const june = splitPayoutAmount(4500, splits); // 2700 / 1800
    const july = splitPayoutAmount(9000, splits); // 5400 / 3600

    // 汇总表头：参与人 | 合计金额(元) | 2026-06(元) | 2026-07(元)
    const header = summarySheet!.getRow(1).values as string[];
    expect(header.slice(1)).toEqual(["参与人", "合计金额(元)", "2026-06(元)", "2026-07(元)"]);

    const rows = [2, 3, 4].map((r) => summarySheet!.getRow(r).values as (string | number)[]);
    const byName = new Map(rows.map((v) => [v[1] as string, v]));
    const dealOwnerRow = byName.get("昵称-dealowner-exp")!;
    expect(dealOwnerRow.slice(2)).toEqual([
      (june[0]!.amountCents + july[0]!.amountCents) / 100,
      june[0]!.amountCents / 100,
      july[0]!.amountCents / 100,
    ]);
    const ownerRow = byName.get("昵称-owner-exp")!;
    expect(ownerRow.slice(2)).toEqual([
      (june[1]!.amountCents + july[1]!.amountCents) / 100,
      june[1]!.amountCents / 100,
      july[1]!.amountCents / 100,
    ]);
    const totalRow = byName.get("总计")!;
    expect(totalRow.slice(2)).toEqual([(4500 + 9000) / 100, 4500 / 100, 9000 / 100]);

    // 明细长表：2 明细 × 2 参与人 = 4 行
    expect(detailSheet!.rowCount).toBe(5);
    const firstRow = detailSheet!.getRow(2).values as (string | number | Date)[];
    expect(firstRow[1]).toBe("导出批次");
    expect(firstRow[4]).toBe("2026-06"); // 成交月份
    expect(firstRow[5]).toBe("产品-导出");
  });

  it("批次不存在 → 404", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await get("/api/v1/payout-batches/99999/export.xlsx", cookie)).statusCode).toBe(404);
  });
});
