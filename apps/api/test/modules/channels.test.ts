// channels CRUD + K27 密钥字段 + channel_owners（PR 6）。inject + loginAs，假时钟控 updatedAt。
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
  clock = { t: Date.now() }; // epoch 毫秒
  app = buildApp({ env: testEnv(), db: tmp.db, now: () => clock.t, gcProbability: 0 });
});

afterEach(async () => {
  await app.close();
  tmp.cleanup();
});

/** 种一个指定角色的可登录用户并返回 cookie */
async function loginAsRole(
  role: "admin" | "operator" | "assistant",
  username = `u-${role}`,
): Promise<{ id: number; cookie: string }> {
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

const SECRET_FIELDS = ["accountId", "registerPhone", "registrant", "realNamePerson", "loginDevice"];

/** 以 admin 建一个带全字段的渠道（含密钥与 notes），返回响应 data */
async function createChannelAsAdmin(extra: JsonBody = {}) {
  const { id: adminId, cookie } = await loginAsRole("admin");
  const res = await post("/api/v1/channels", cookie, {
    name: "主渠道",
    notes: "备注甲",
    accountId: "gh_abc123",
    registerPhone: "13800001234",
    registrant: "张三",
    realNamePerson: "李四",
    loginDevice: "iPhone 15",
    ...extra,
  });
  expect(res.statusCode).toBe(201);
  return { adminId, cookie, data: res.json().data };
}

describe("RBAC 矩阵（channels 资源）", () => {
  it("assistant：POST/DELETE → 403；GET list/read → 200；PATCH 非密钥 → 200", async () => {
    const { cookie } = await loginAsRole("assistant");
    const { data: ch } = await createChannelAsAdmin();

    expect((await post("/api/v1/channels", cookie, { name: "x" })).statusCode).toBe(403);
    expect((await del(`/api/v1/channels/${ch.id}`, cookie)).statusCode).toBe(403);
    expect((await get("/api/v1/channels", cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/channels/${ch.id}`, cookie)).statusCode).toBe(200);

    clock.t += 1000;
    const res = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      notes: "助手改备注",
      updatedAt: ch.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.notes).toBe("助手改备注");
  });

  it("assistant GET one/list：五个密钥字段全 null，其它字段正常", async () => {
    const { cookie } = await loginAsRole("assistant");
    const { data: ch } = await createChannelAsAdmin();

    const one = (await get(`/api/v1/channels/${ch.id}`, cookie)).json().data;
    for (const f of SECRET_FIELDS) expect(one[f]).toBeNull();
    expect(one.name).toBe("主渠道");
    expect(one.notes).toBe("备注甲");

    const list = (await get("/api/v1/channels", cookie)).json();
    const item = list.data.find((c: { id: number }) => c.id === ch.id);
    for (const f of SECRET_FIELDS) expect(item[f]).toBeNull();
    expect(item.name).toBe("主渠道");
  });

  it("assistant PATCH 含密钥键 → 403（值即使是 null，键存在即拦）", async () => {
    const { cookie } = await loginAsRole("assistant");
    const { data: ch } = await createChannelAsAdmin();

    const r1 = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      accountId: "hack",
      updatedAt: ch.updatedAt,
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe("FORBIDDEN");

    const r2 = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      registerPhone: null,
      updatedAt: ch.updatedAt,
    });
    expect(r2.statusCode).toBe(403);
  });

  it("operator/admin：密钥可见原值、可改", async () => {
    const { data: ch } = await createChannelAsAdmin();
    const { cookie: opCookie } = await loginAsRole("operator");

    const one = (await get(`/api/v1/channels/${ch.id}`, opCookie)).json().data;
    expect(one.accountId).toBe("gh_abc123");
    expect(one.registerPhone).toBe("13800001234");
    expect(one.registrant).toBe("张三");
    expect(one.realNamePerson).toBe("李四");
    expect(one.loginDevice).toBe("iPhone 15");

    clock.t += 1000;
    const res = await patch(`/api/v1/channels/${ch.id}`, opCookie, {
      accountId: "gh_new",
      updatedAt: ch.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.accountId).toBe("gh_new");
  });

  it("admin 全通（create/read/update/delete）", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    clock.t += 1000;
    expect(
      (await patch(`/api/v1/channels/${ch.id}`, cookie, { status: "paused", updatedAt: ch.updatedAt }))
        .statusCode,
    ).toBe(200);
    expect((await del(`/api/v1/channels/${ch.id}`, cookie)).statusCode).toBe(204);
  });
});

describe("POST /api/v1/channels 创建", () => {
  it("省略可选字段 → 默认值；审计列展开；可同时带 ownerIds", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const ownerId = await seedUser(tmp.db, { username: "owner1", nickname: "负责人一" });
    const res = await post("/api/v1/channels", cookie, { name: "新渠道", ownerIds: [ownerId] });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.platform).toBe("other");
    expect(data.channelType).toBe("private");
    expect(data.accountType).toBe("public_account");
    expect(data.status).toBe("operating");
    expect(data.owners).toEqual([{ id: ownerId, nickname: "负责人一" }]);
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(data.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("ownerIds 引用不存在的用户 → 422（事务回滚，渠道未创建）", async () => {
    const { cookie } = await loginAsRole("admin");
    const res = await post("/api/v1/channels", cookie, { name: "x", ownerIds: [9999] });
    expect(res.statusCode).toBe(422);
    expect((await get("/api/v1/channels", cookie)).json().meta.total).toBe(0);
  });

  it("缺 name / name 为空 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/channels", cookie, {})).statusCode).toBe(422);
    expect((await post("/api/v1/channels", cookie, { name: "" })).statusCode).toBe(422);
  });
});

describe("GET /api/v1/channels 列表", () => {
  it("分页 meta 正确；list 不含软删行", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    await post("/api/v1/channels", cookie, { name: "渠道二" });
    await post("/api/v1/channels", cookie, { name: "渠道三" });

    const res = await get("/api/v1/channels?page=2&pageSize=2", cookie);
    expect(res.json().meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(res.json().data).toHaveLength(1);

    await del(`/api/v1/channels/${ch.id}`, cookie);
    const after = await get("/api/v1/channels", cookie);
    expect(after.json().meta.total).toBe(2);
    expect(after.json().data.map((c: { name: string }) => c.name)).not.toContain("主渠道");
  });

  it("q 命中 name/accountId/registerPhone/notes；多 token AND", async () => {
    const { cookie } = await createChannelAsAdmin();
    await post("/api/v1/channels", cookie, { name: "小红书矩阵", notes: "矩阵笔记" });

    // 单 token 命中密钥列 account_id
    const byAccount = await get("/api/v1/channels?q=gh_abc123", cookie);
    expect(byAccount.json().data.map((c: { name: string }) => c.name)).toEqual(["主渠道"]);
    // 命中 register_phone
    const byPhone = await get("/api/v1/channels?q=13800001234", cookie);
    expect(byPhone.json().meta.total).toBe(1);
    // 多 token AND：两个 token 需同时命中同一行
    const multi = await get("/api/v1/channels?q=" + encodeURIComponent("主渠道 备注甲"), cookie);
    expect(multi.json().meta.total).toBe(1);
    const none = await get("/api/v1/channels?q=" + encodeURIComponent("主渠道 矩阵"), cookie);
    expect(none.json().meta.total).toBe(0);
  });

  it("过滤 platform/channelType/accountType/status；非法枚举 → 422", async () => {
    const { cookie } = await createChannelAsAdmin({ platform: "wechat", status: "paused" });
    await post("/api/v1/channels", cookie, { name: "默认渠道" });

    const paused = await get("/api/v1/channels?status=paused", cookie);
    expect(paused.json().meta.total).toBe(1);
    expect(paused.json().data[0].name).toBe("主渠道");
    expect((await get("/api/v1/channels?platform=wechat", cookie)).json().meta.total).toBe(1);
    expect((await get("/api/v1/channels?channelType=public", cookie)).json().meta.total).toBe(0);
    expect((await get("/api/v1/channels?accountType=wechat_group", cookie)).json().meta.total).toBe(0);
    expect((await get("/api/v1/channels?platform=bogus", cookie)).statusCode).toBe(422);
  });

  it("sort=name asc 放行；默认 updatedAt desc + id DESC；非法 sort → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/channels", cookie, { name: "B渠道" });
    await post("/api/v1/channels", cookie, { name: "A渠道" });

    const asc = await get("/api/v1/channels?sort=name&order=asc", cookie);
    expect(asc.json().data.map((c: { name: string }) => c.name)).toEqual(["A渠道", "B渠道"]);

    // 默认：同毫秒创建时 id DESC（后建在前）
    const dflt = await get("/api/v1/channels", cookie);
    expect(dflt.json().data[0].name).toBe("A渠道");

    expect((await get("/api/v1/channels?sort=deletedAt", cookie)).statusCode).toBe(422);
  });
});

describe("GET /api/v1/channels/:id", () => {
  it("camelCase 完整行，无 snake_case 泄漏；软删/不存在 → 404；非法 id → 422", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    const res = await get(`/api/v1/channels/${ch.id}`, cookie);
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("account_id");
    expect(raw).not.toContain("register_phone");
    expect(raw).not.toContain("created_at");
    expect(raw).not.toContain("deletedAt");

    expect((await get("/api/v1/channels/9999", cookie)).statusCode).toBe(404);
    expect((await get("/api/v1/channels/abc", cookie)).statusCode).toBe(422);

    await del(`/api/v1/channels/${ch.id}`, cookie);
    expect((await get(`/api/v1/channels/${ch.id}`, cookie)).statusCode).toBe(404);
  });
});

describe("PATCH /api/v1/channels/:id 内核（K24）", () => {
  it("必测1：PATCH name 不碰 notes", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    clock.t += 1000;
    const res = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      name: "改名",
      updatedAt: ch.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe("改名");
    expect(res.json().data.notes).toBe("备注甲");
  });

  it("仅带 updatedAt 的 {} → 200，仅 bump updatedAt/updatedBy", async () => {
    const { adminId, cookie, data: ch } = await createChannelAsAdmin();
    clock.t += 1000;
    const res = await patch(`/api/v1/channels/${ch.id}`, cookie, { updatedAt: ch.updatedAt });
    expect(res.statusCode).toBe(200);
    const after = res.json().data;
    expect(after.name).toBe("主渠道");
    expect(after.updatedAt).toBe(clock.t);
    expect(after.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("必测3/4：同一 updatedAt 两次 PATCH → 200 后 409；用新 updatedAt → 200；409 data 带当前行", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    clock.t += 1000;
    const r1 = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      name: "第一改",
      updatedAt: ch.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      name: "第二改",
      updatedAt: ch.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    expect(r2.json().data.name).toBe("第一改");
    expect(r2.json().data.updatedAt).toBe(r1.json().data.updatedAt);

    const r3 = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      name: "第三改",
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.name).toBe("第三改");
  });

  it("非空列 name SET null → 422；可空列 notes SET null → 200 清空", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    const bad = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      name: null,
      updatedAt: ch.updatedAt,
    });
    expect(bad.statusCode).toBe(422);

    clock.t += 1000;
    const ok = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      notes: null,
      updatedAt: ch.updatedAt,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.notes).toBeNull();
  });

  it("缺 updatedAt → 422；软删行 PATCH → 404（不是 409）", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    expect(
      (await patch(`/api/v1/channels/${ch.id}`, cookie, { name: "x" })).statusCode,
    ).toBe(422);

    await del(`/api/v1/channels/${ch.id}`, cookie);
    const res = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      name: "x",
      updatedAt: ch.updatedAt,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("ownerIds 关系（channel_owners）", () => {
  it("PATCH ownerIds：缺席不动 / [] 清空 / [ids] 整表替换并 bump updatedAt", async () => {
    const { cookie } = await loginAsRole("admin");
    const u1 = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    const u2 = await seedUser(tmp.db, { username: "o2", nickname: "二" });
    const created = await post("/api/v1/channels", cookie, { name: "c", ownerIds: [u1] });
    const ch = created.json().data;

    // 缺席 → 不动
    clock.t += 1000;
    const keep = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      notes: "n",
      updatedAt: ch.updatedAt,
    });
    expect(keep.json().data.owners).toEqual([{ id: u1, nickname: "一" }]);

    // [ids] → 替换，updatedAt bump
    clock.t += 1000;
    const replaced = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      ownerIds: [u2, u1],
      updatedAt: keep.json().data.updatedAt,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().data.owners).toHaveLength(2);
    expect(replaced.json().data.updatedAt).toBe(clock.t);

    // [] → 清空
    clock.t += 1000;
    const cleared = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      ownerIds: [],
      updatedAt: replaced.json().data.updatedAt,
    });
    expect(cleared.json().data.owners).toEqual([]);
    const joinCount = tmp.sqlite
      .prepare("SELECT COUNT(*) AS c FROM channel_owners WHERE channel_id = ?")
      .get(ch.id) as { c: number };
    expect(joinCount.c).toBe(0);
  });

  it("PATCH ownerIds 引用已软删用户 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const ghost = await seedUser(tmp.db, { username: "ghost", deletedAt: clock.t });
    const created = await post("/api/v1/channels", cookie, { name: "c" });
    const ch = created.json().data;

    clock.t += 1000;
    const res = await patch(`/api/v1/channels/${ch.id}`, cookie, {
      ownerIds: [ghost],
      updatedAt: ch.updatedAt,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("VALIDATION");
  });

  it("软删 owner 用户后：GET owners 不含该用户，但 join 行仍在（K9）", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    const { id: opId } = await loginAsRole("operator");
    const created = await post("/api/v1/channels", adminCookie, { name: "c", ownerIds: [opId] });
    const ch = created.json().data;
    expect(created.json().data.owners).toEqual([{ id: opId, nickname: "昵称-operator" }]);

    expect((await del(`/api/v1/users/${opId}`, adminCookie)).statusCode).toBe(204);

    const res = await get(`/api/v1/channels/${ch.id}`, adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.owners).toEqual([]);
    // join 行不剥
    const joinCount = tmp.sqlite
      .prepare("SELECT COUNT(*) AS c FROM channel_owners WHERE channel_id = ?")
      .get(ch.id) as { c: number };
    expect(joinCount.c).toBe(1);
  });
});

describe("DELETE /api/v1/channels/:id", () => {
  it("软删：204；重复删除/不存在 → 404；行仍在库", async () => {
    const { cookie, data: ch } = await createChannelAsAdmin();
    expect((await del(`/api/v1/channels/${ch.id}`, cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/channels/${ch.id}`, cookie)).statusCode).toBe(404);
    expect((await del("/api/v1/channels/9999", cookie)).statusCode).toBe(404);
    const row = tmp.sqlite
      .prepare("SELECT deleted_at FROM channels WHERE id = ?")
      .get(ch.id) as { deleted_at: number };
    expect(row.deleted_at).toBe(clock.t);
  });
});
