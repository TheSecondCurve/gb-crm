// K55 客户维护记录（customer-records）：CRUD + kind/happenedAt 校验 + PATCH 内核（K24）+ OCC +
// 软删 + RBAC + lastFollowedAt 联动。inject + loginAs，假时钟控 updatedAt/时间。
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

async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
  const id = await seedUser(tmp.db, { username, systemRole: role, nickname: `昵称-${role}` });
  const cookie = await loginAs(app, username, "password123");
  return { id, cookie };
}

type JsonBody = Record<string, unknown>;

type RecordDto = {
  id: number;
  kind: string;
  happenedAt: number;
  content: string | null;
  createdAt: number;
  updatedAt: number;
};

const get = (url: string, cookie: string) =>
  app.inject({ method: "GET", url, headers: { cookie } });
const post = (url: string, cookie: string, payload?: JsonBody) =>
  app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
const patch = (url: string, cookie: string, payload: JsonBody) =>
  app.inject({ method: "PATCH", url, headers: { cookie }, payload });
const del = (url: string, cookie: string) =>
  app.inject({ method: "DELETE", url, headers: { cookie } });

async function createCustomer(cookie: string, nickname: string): Promise<number> {
  const res = await post("/api/v1/customers", cookie, { nickname });
  expect(res.statusCode).toBe(201);
  return res.json().data.id;
}

async function createRecord(cookie: string, customerId: number, payload: JsonBody): Promise<RecordDto> {
  const res = await post(`/api/v1/customers/${customerId}/records`, cookie, payload);
  expect(res.statusCode).toBe(201);
  return res.json().data;
}

describe("RBAC（customerRecords 资源，K55）", () => {
  it("assistant：list/read 200；create/update/delete 403；未登录 401", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "客户A");
    const r = await createRecord(admin.cookie, cid, { kind: "follow_up", happenedAt: clock.t });

    const asst = await loginAsRole("assistant");
    expect((await get(`/api/v1/customers/${cid}/records`, asst.cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/customers/${cid}/records/${r.id}`, asst.cookie)).statusCode).toBe(200);
    expect((await post(`/api/v1/customers/${cid}/records`, asst.cookie, { kind: "lead", happenedAt: clock.t })).statusCode).toBe(403);
    expect((await patch(`/api/v1/customers/${cid}/records/${r.id}`, asst.cookie, { content: "x", updatedAt: r.updatedAt })).statusCode).toBe(403);
    expect((await del(`/api/v1/customers/${cid}/records/${r.id}`, asst.cookie)).statusCode).toBe(403);

    expect((await app.inject({ method: "GET", url: `/api/v1/customers/${cid}/records` })).statusCode).toBe(401);
  });

  it("admin/operator 全量 200/201", async () => {
    for (const role of ["admin", "operator"] as const) {
      const u = await loginAsRole(role);
      const cid = await createCustomer(u.cookie, `客户-${role}`);
      const r = await createRecord(u.cookie, cid, { kind: "note", happenedAt: clock.t, content: "备注" });
      expect((await get(`/api/v1/customers/${cid}/records`, u.cookie)).statusCode).toBe(200);
      expect((await patch(`/api/v1/customers/${cid}/records/${r.id}`, u.cookie, { content: "改", updatedAt: r.updatedAt })).statusCode).toBe(200);
      expect((await del(`/api/v1/customers/${cid}/records/${r.id}`, u.cookie)).statusCode).toBe(204);
    }
  });
});

describe("CRUD + 校验（K55）", () => {
  it("create → list（分页+kind 过滤）→ get → patch → delete（软删后 GET 404、list 不含）", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "客户B");

    const a = await createRecord(admin.cookie, cid, { kind: "follow_up", happenedAt: 1000, content: "首次沟通" });
    const b = await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: 2000, content: "对1v1感兴趣" });
    expect(a.id).toBeLessThan(b.id);

    // list：happenedAt desc（最新在前）
    const listRes = await get(`/api/v1/customers/${cid}/records`, admin.cookie);
    expect(listRes.statusCode).toBe(200);
    const body = listRes.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
    expect(body.data[0]).toMatchObject({ id: b.id, kind: "lead", happenedAt: 2000, content: "对1v1感兴趣" });
    expect(body.data[1]).toMatchObject({ kind: "follow_up" });

    // kind 过滤
    const filtered = await get(`/api/v1/customers/${cid}/records?kind=follow_up`, admin.cookie);
    expect(filtered.json().data).toHaveLength(1);

    // get 单条
    expect((await get(`/api/v1/customers/${cid}/records/${a.id}`, admin.cookie)).json().data).toMatchObject({
      id: a.id,
      kind: "follow_up",
      customerId: cid,
    });

    // patch（OCC）
    const patched = await patch(`/api/v1/customers/${cid}/records/${a.id}`, admin.cookie, {
      content: "更新后的内容",
      updatedAt: a.updatedAt,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.content).toBe("更新后的内容");

    // delete（软删）
    expect((await del(`/api/v1/customers/${cid}/records/${a.id}`, admin.cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/customers/${cid}/records/${a.id}`, admin.cookie)).statusCode).toBe(404);
    const after = await get(`/api/v1/customers/${cid}/records`, admin.cookie);
    expect(after.json().data).toHaveLength(1);
    expect(after.json().data[0].id).toBe(b.id);
  });

  it("校验：kind 非法 422；happenedAt 缺失 422；customer 不存在/软删 404", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "客户C");

    expect((await post(`/api/v1/customers/${cid}/records`, admin.cookie, { kind: "vip", happenedAt: 1 })).statusCode).toBe(422);
    expect((await post(`/api/v1/customers/${cid}/records`, admin.cookie, { kind: "note" })).statusCode).toBe(422);

    expect((await post(`/api/v1/customers/999999/records`, admin.cookie, { kind: "note", happenedAt: 1 })).statusCode).toBe(404);

    // 软删客户后不可再读记录
    expect((await del(`/api/v1/customers/${cid}`, admin.cookie)).statusCode).toBe(204);
    expect((await get(`/api/v1/customers/${cid}/records`, admin.cookie)).statusCode).toBe(404);
  });

  it("OCC：updatedAt 不匹配 → 409 带当前行", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "客户D");
    const r = await createRecord(admin.cookie, cid, { kind: "note", happenedAt: clock.t });
    const res = await patch(`/api/v1/customers/${cid}/records/${r.id}`, admin.cookie, {
      content: "x",
      updatedAt: r.updatedAt + 1,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().data).toMatchObject({ id: r.id });
  });

  it("lastFollowedAt 联动：follow_up/lead 记录刷新客户最近跟进时间", async () => {
    const admin = await loginAsRole("admin");
    const cid = await createCustomer(admin.cookie, "客户E");

    // 初始 lastFollowedAt 为 null
    const before = await get(`/api/v1/customers/${cid}`, admin.cookie);
    expect(before.json().data.lastFollowedAt).toBeNull();

    // follow_up 记录 happenedAt=5000 → 联动 bump
    await createRecord(admin.cookie, cid, { kind: "follow_up", happenedAt: 5000 });
    let one = await get(`/api/v1/customers/${cid}`, admin.cookie);
    expect(one.json().data.lastFollowedAt).toBe(5000);

    // 更早的 lead 不覆盖（取 max）
    await createRecord(admin.cookie, cid, { kind: "lead", happenedAt: 1000 });
    one = await get(`/api/v1/customers/${cid}`, admin.cookie);
    expect(one.json().data.lastFollowedAt).toBe(5000);

    // note 不联动
    await createRecord(admin.cookie, cid, { kind: "note", happenedAt: 9000 });
    one = await get(`/api/v1/customers/${cid}`, admin.cookie);
    expect(one.json().data.lastFollowedAt).toBe(5000);
  });
});
