// customers CRUD + 两张 join + 归属人单值（K39）+ wechatOpenid + K31 权限（PR 7）。
// inject + loginAs，假时钟控 updatedAt；PATCH 内核走收口后的 lib/patch-kernel.ts。
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import type { Db } from "../../src/db/client.js";
import { channels } from "../../src/db/schema.js";
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

/** 直接插一个渠道（列表/关系测试的陪衬数据，不走 API） */
function seedChannel(db: Db, name: string, deletedAt: number | null = null): number {
  const now = clock.t;
  return Number(
    db.insert(channels).values({ name, createdAt: now, updatedAt: now, deletedAt }).run()
      .lastInsertRowid,
  );
}

/** 以 admin 建一个客户，返回响应 data（每次用唯一 username，避免与同测试内其它 loginAsRole 冲突） */
let adminSeq = 0;
async function createCustomerAsAdmin(extra: JsonBody = {}) {
  const { id: adminId, cookie } = await loginAsRole("admin", `u-admin-${adminSeq++}`);
  const res = await post("/api/v1/customers", cookie, { nickname: "客户甲", ...extra });
  expect(res.statusCode).toBe(201);
  return { adminId, cookie, data: res.json().data };
}

const joinCount = (table: string, customerId: number): number =>
  (
    tmp.sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE customer_id = ?`).get(customerId) as {
      c: number;
    }
  ).c;

/** 归属人单值（K39）：直接读 customers.owner_id */
const ownerIdOf = (customerId: number): number | null =>
  (
    tmp.sqlite.prepare("SELECT owner_id FROM customers WHERE id = ?").get(customerId) as {
      owner_id: number | null;
    }
  ).owner_id;

describe("RBAC 矩阵（customers 资源，K31 锁定）", () => {
  it("assistant：POST → 403；DELETE → 403；GET list/read → 200", async () => {
    const { cookie } = await loginAsRole("assistant");
    const { data: c } = await createCustomerAsAdmin();

    expect((await post("/api/v1/customers", cookie, { nickname: "x" })).statusCode).toBe(403);
    expect((await del(`/api/v1/customers/${c.id}`, cookie)).statusCode).toBe(403);
    expect((await get("/api/v1/customers", cookie)).statusCode).toBe(200);
    expect((await get(`/api/v1/customers/${c.id}`, cookie)).statusCode).toBe(200);
  });

  it("assistant PATCH 普通标量 { nickname, updatedAt } → 200", async () => {
    const { cookie } = await loginAsRole("assistant");
    const { data: c } = await createCustomerAsAdmin();

    clock.t += 1000;
    const res = await patch(`/api/v1/customers/${c.id}`, cookie, {
      nickname: "助手改名",
      updatedAt: c.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.nickname).toBe("助手改名");
  });

  it("assistant PATCH 含 ownerId 键 → 403（键存在即拦，null 也算）", async () => {
    const { id: asstId, cookie } = await loginAsRole("assistant");
    const { data: c } = await createCustomerAsAdmin();

    const r1 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      ownerId: asstId,
      updatedAt: c.updatedAt,
    });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe("FORBIDDEN");

    const r3 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      ownerId: null,
      updatedAt: c.updatedAt,
    });
    expect(r3.statusCode).toBe(403);
  });

  it("operator：POST 201、PATCH ownerId 200、DELETE 204（K31 只锁 assistant）", async () => {
    const { id: opId, cookie } = await loginAsRole("operator");
    const created = await post("/api/v1/customers", cookie, { nickname: "运营建" });
    expect(created.statusCode).toBe(201);
    const c = created.json().data;

    clock.t += 1000;
    const patched = await patch(`/api/v1/customers/${c.id}`, cookie, {
      ownerId: opId,
      updatedAt: c.updatedAt,
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.owner).toEqual({ id: opId, nickname: "昵称-operator" });

    expect((await del(`/api/v1/customers/${c.id}`, cookie)).statusCode).toBe(204);
  });

  it("未登录 → 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/customers" })).statusCode).toBe(401);
  });
});

describe("POST /api/v1/customers 创建", () => {
  it("省略可选字段 → 默认值；审计列展开；可同时带归属人与关系数组", async () => {
    const { id: adminId, cookie } = await loginAsRole("admin");
    const ownerId = await seedUser(tmp.db, { username: "owner1", nickname: "归属人一" });
    const chId = seedChannel(tmp.db, "来源渠道一");

    const res = await post("/api/v1/customers", cookie, {
      nickname: "客户全量",
      tagCodes: ["vip", "ip"],
      ownerId,
      sourceChannelIds: [chId],
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.customerType).toBe("customer"); // schema 默认
    expect(data.tagCodes).toEqual(expect.arrayContaining(["vip", "ip"]));
    expect(data.owner).toEqual({ id: ownerId, nickname: "归属人一" });
    expect(data.sourceChannels).toEqual([{ id: chId, name: "来源渠道一" }]);
    expect(data.createdBy).toEqual({ id: adminId, nickname: "昵称-admin" });
    expect(data.updatedBy).toEqual({ id: adminId, nickname: "昵称-admin" });
  });

  it("nickname 必填（API 不代填「未命名客户」，默认值由 web/导入侧决定）：缺失/空 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    expect((await post("/api/v1/customers", cookie, {})).statusCode).toBe(422);
    expect((await post("/api/v1/customers", cookie, { nickname: "" })).statusCode).toBe(422);
  });

  it("ownerId 引用不存在/已软删用户 → 422（事务回滚，客户未创建）", async () => {
    const { cookie } = await loginAsRole("admin");
    const ghost = await seedUser(tmp.db, { username: "ghost", deletedAt: clock.t });

    expect(
      (await post("/api/v1/customers", cookie, { nickname: "x", ownerId: 9999 })).statusCode,
    ).toBe(422);
    expect(
      (await post("/api/v1/customers", cookie, { nickname: "x", ownerId: ghost })).statusCode,
    ).toBe(422);
    expect((await get("/api/v1/customers", cookie)).json().meta.total).toBe(0);
  });

  it("tagCodes 非法枚举 → 422；sourceChannelIds 引用软删渠道 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const deadCh = seedChannel(tmp.db, "已删渠道", clock.t);

    expect(
      (await post("/api/v1/customers", cookie, { nickname: "x", tagCodes: ["bogus"] })).statusCode,
    ).toBe(422);
    expect(
      (
        await post("/api/v1/customers", cookie, { nickname: "x", sourceChannelIds: [deadCh] })
      ).statusCode,
    ).toBe(422);
  });
});

describe("PATCH /api/v1/customers/:id 内核（K24）", () => {
  it("必测1：PATCH nickname 不碰 phone（partial PATCH 只 SET 出现的键）", async () => {
    const { cookie, data: c } = await createCustomerAsAdmin({ phone: "1" });
    clock.t += 1000;
    const res = await patch(`/api/v1/customers/${c.id}`, cookie, {
      nickname: "改名",
      updatedAt: c.updatedAt,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.nickname).toBe("改名");
    expect(res.json().data.phone).toBe("1");
  });

  it("必测2a：PATCH {} 仅 updatedAt → 200，join 与 owner 不变、updatedAt bump", async () => {
    const { cookie } = await loginAsRole("admin");
    const ownerId = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    const created = await post("/api/v1/customers", cookie, {
      nickname: "c",
      ownerId,
      tagCodes: ["vip"],
    });
    const c = created.json().data;

    clock.t += 1000;
    const res = await patch(`/api/v1/customers/${c.id}`, cookie, { updatedAt: c.updatedAt });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.updatedAt).toBe(clock.t);
    expect(res.json().data.owner).toEqual({ id: ownerId, nickname: "一" });
    expect(res.json().data.tagCodes).toEqual(["vip"]);
  });

  it("必测2b：ownerId 新值 → 覆盖；null → 清空，并 bump updatedAt", async () => {
    const { cookie } = await loginAsRole("admin");
    const u1 = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    const u2 = await seedUser(tmp.db, { username: "o2", nickname: "二" });
    const created = await post("/api/v1/customers", cookie, { nickname: "c", ownerId: u1 });
    const c = created.json().data;

    // 新值 → 覆盖（单值语义，不再是整表替换）
    clock.t += 1000;
    const replaced = await patch(`/api/v1/customers/${c.id}`, cookie, {
      ownerId: u2,
      updatedAt: c.updatedAt,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().data.owner).toEqual({ id: u2, nickname: "二" });
    expect(replaced.json().data.updatedAt).toBe(clock.t);

    // null → 清空（owner_id 变 NULL）
    clock.t += 1000;
    const cleared = await patch(`/api/v1/customers/${c.id}`, cookie, {
      ownerId: null,
      updatedAt: replaced.json().data.updatedAt,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.owner).toBeNull();
    expect(ownerIdOf(c.id)).toBeNull();
  });

  it("必测3/4：同一 updatedAt 两次 PATCH → 200 后 409；用新 updatedAt → 200；409 data 带当前完整行（含 expansions）", async () => {
    const { cookie } = await loginAsRole("admin");
    const ownerId = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    const created = await post("/api/v1/customers", cookie, {
      nickname: "c",
      phone: "1",
      ownerId,
    });
    const c = created.json().data;

    clock.t += 1000;
    const r1 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      nickname: "第一改",
      updatedAt: c.updatedAt,
    });
    expect(r1.statusCode).toBe(200);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      nickname: "第二改",
      updatedAt: c.updatedAt,
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe("CONFLICT");
    const current = r2.json().data;
    expect(current.nickname).toBe("第一改");
    expect(current.updatedAt).toBe(r1.json().data.updatedAt);
    expect(current.owner).toEqual({ id: ownerId, nickname: "一" });

    const r3 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      nickname: "第三改",
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r3.statusCode).toBe(200);
    expect(r3.json().data.nickname).toBe("第三改");
  });

  it("非空列 nickname SET null → 422；可空列 phone SET null → 200 清空；'' 与 null 不同", async () => {
    const { cookie, data: c } = await createCustomerAsAdmin({ phone: "1" });
    expect(
      (await patch(`/api/v1/customers/${c.id}`, cookie, { nickname: null, updatedAt: c.updatedAt }))
        .statusCode,
    ).toBe(422);

    clock.t += 1000;
    const cleared = await patch(`/api/v1/customers/${c.id}`, cookie, {
      phone: null,
      updatedAt: c.updatedAt,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.phone).toBeNull();

    clock.t += 1000;
    const empty = await patch(`/api/v1/customers/${c.id}`, cookie, {
      phone: "",
      updatedAt: cleared.json().data.updatedAt,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data.phone).toBe("");
  });

  it("缺 updatedAt → 422；软删行 PATCH → 404（不是 409）", async () => {
    const { cookie, data: c } = await createCustomerAsAdmin();
    expect(
      (await patch(`/api/v1/customers/${c.id}`, cookie, { nickname: "x" })).statusCode,
    ).toBe(422);

    await del(`/api/v1/customers/${c.id}`, cookie);
    const res = await patch(`/api/v1/customers/${c.id}`, cookie, {
      nickname: "x",
      updatedAt: c.updatedAt,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("关系展开与软删（K9）", () => {
  it("软删 owner 用户后：GET owner: null，但 owner_id 仍指向原用户（K9）", async () => {
    const { cookie: adminCookie } = await loginAsRole("admin");
    const { id: opId } = await loginAsRole("operator");
    const created = await post("/api/v1/customers", adminCookie, {
      nickname: "c",
      ownerId: opId,
    });
    const c = created.json().data;
    expect(c.owner).toEqual({ id: opId, nickname: "昵称-operator" });

    expect((await del(`/api/v1/users/${opId}`, adminCookie)).statusCode).toBe(204);

    const res = await get(`/api/v1/customers/${c.id}`, adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.owner).toBeNull();
    expect(ownerIdOf(c.id)).toBe(opId);
  });

  it("PATCH tagCodes：[tags] 替换、[] 清空、非法值 422；渠道关系整表替换", async () => {
    const { cookie } = await loginAsRole("admin");
    const ch1 = seedChannel(tmp.db, "渠道一");
    const ch2 = seedChannel(tmp.db, "渠道二");
    const created = await post("/api/v1/customers", cookie, {
      nickname: "c",
      tagCodes: ["vip"],
      sourceChannelIds: [ch1],
    });
    const c = created.json().data;

    clock.t += 1000;
    const r1 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      tagCodes: ["ip", "guest"],
      sourceChannelIds: [ch2],
      updatedAt: c.updatedAt,
    });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data.tagCodes).toEqual(expect.arrayContaining(["ip", "guest"]));
    expect(r1.json().data.sourceChannels).toEqual([{ id: ch2, name: "渠道二" }]);

    clock.t += 1000;
    const r2 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      tagCodes: [],
      updatedAt: r1.json().data.updatedAt,
    });
    expect(r2.json().data.tagCodes).toEqual([]);
    expect(joinCount("customer_tags", c.id)).toBe(0);

    const bad = await patch(`/api/v1/customers/${c.id}`, cookie, {
      tagCodes: ["not-a-tag"],
      updatedAt: r2.json().data.updatedAt,
    });
    expect(bad.statusCode).toBe(422);
  });

  it("PATCH 关系键引用不存在/软删对象 → 422（users 与 channels 同规则）", async () => {
    const { cookie } = await loginAsRole("admin");
    const deadCh = seedChannel(tmp.db, "已删渠道", clock.t);
    const ghost = await seedUser(tmp.db, { username: "ghost", deletedAt: clock.t });
    const { data: c } = await createCustomerAsAdmin();

    const r1 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      ownerId: ghost,
      updatedAt: c.updatedAt,
    });
    expect(r1.statusCode).toBe(422);

    const r2 = await patch(`/api/v1/customers/${c.id}`, cookie, {
      sourceChannelIds: [deadCh],
      updatedAt: c.updatedAt,
    });
    expect(r2.statusCode).toBe(422);
  });
});

describe("wechatOpenid 可空唯一（live 行内）", () => {
  it("create 冲突 → 409；PATCH 占用他人值 → 409；PATCH 自身同值 → 200", async () => {
    const { cookie } = await loginAsRole("admin");
    const c1 = (
      await post("/api/v1/customers", cookie, { nickname: "c1", wechatOpenid: "openid-1" })
    ).json().data;

    const dup = await post("/api/v1/customers", cookie, {
      nickname: "c2",
      wechatOpenid: "openid-1",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");

    const c2 = (await post("/api/v1/customers", cookie, { nickname: "c2" })).json().data;
    clock.t += 1000;
    const steal = await patch(`/api/v1/customers/${c2.id}`, cookie, {
      wechatOpenid: "openid-1",
      updatedAt: c2.updatedAt,
    });
    expect(steal.statusCode).toBe(409);

    // 自身同值不算冲突
    clock.t += 1000;
    const self = await patch(`/api/v1/customers/${c1.id}`, cookie, {
      wechatOpenid: "openid-1",
      updatedAt: c1.updatedAt,
    });
    expect(self.statusCode).toBe(200);
  });

  it("软删后 openid 释放可复用；PATCH null 清空", async () => {
    const { cookie } = await loginAsRole("admin");
    const c1 = (
      await post("/api/v1/customers", cookie, { nickname: "c1", wechatOpenid: "openid-1" })
    ).json().data;

    expect((await del(`/api/v1/customers/${c1.id}`, cookie)).statusCode).toBe(204);
    const reuse = await post("/api/v1/customers", cookie, {
      nickname: "c2",
      wechatOpenid: "openid-1",
    });
    expect(reuse.statusCode).toBe(201);

    clock.t += 1000;
    const cleared = await patch(`/api/v1/customers/${reuse.json().data.id}`, cookie, {
      wechatOpenid: null,
      updatedAt: reuse.json().data.updatedAt,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.wechatOpenid).toBeNull();

    // 清空后原值可再次使用
    const again = await post("/api/v1/customers", cookie, {
      nickname: "c3",
      wechatOpenid: "openid-1",
    });
    expect(again.statusCode).toBe(201);
  });
});

describe("GET /api/v1/customers 列表", () => {
  it("分页 meta 正确；list 不含软删行", async () => {
    const { cookie, data: c1 } = await createCustomerAsAdmin();
    await post("/api/v1/customers", cookie, { nickname: "客户乙" });
    await post("/api/v1/customers", cookie, { nickname: "客户丙" });

    const res = await get("/api/v1/customers?page=2&pageSize=2", cookie);
    expect(res.json().meta).toEqual({ page: 2, pageSize: 2, total: 3 });
    expect(res.json().data).toHaveLength(1);

    await del(`/api/v1/customers/${c1.id}`, cookie);
    const after = await get("/api/v1/customers", cookie);
    expect(after.json().meta.total).toBe(2);
    expect(after.json().data.map((c: { nickname: string }) => c.nickname)).not.toContain("客户甲");
  });

  it("q 命中 nickname/real_name/phone/wechat/city/origin_story/notes；多 token AND", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/customers", cookie, {
      nickname: "张三疯",
      realName: "张三丰",
      phone: "13900001111",
      wechat: "zsf-wechat",
      city: "杭州",
      originStory: "武当山的故事",
      notes: "重点客户备注",
    });
    await post("/api/v1/customers", cookie, { nickname: "李四" });

    for (const q of ["张三疯", "张三丰", "13900001111", "zsf-wechat", "杭州", "武当山", "重点客户"]) {
      const res = await get(`/api/v1/customers?q=${encodeURIComponent(q)}`, cookie);
      expect(res.json().meta.total).toBe(1);
      expect(res.json().data[0].nickname).toBe("张三疯");
    }
    const multi = await get(
      "/api/v1/customers?q=" + encodeURIComponent("张三疯 杭州"),
      cookie,
    );
    expect(multi.json().meta.total).toBe(1);
    const none = await get("/api/v1/customers?q=" + encodeURIComponent("张三疯 北京"), cookie);
    expect(none.json().meta.total).toBe(0);
  });

  it("过滤 customerType/tag/ownerId 生效；非法枚举 → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    const u1 = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    await post("/api/v1/customers", cookie, {
      nickname: "企业客户",
      customerType: "company",
      tagCodes: ["vip"],
      ownerId: u1,
    });
    await post("/api/v1/customers", cookie, { nickname: "普通客户" });

    const byType = await get("/api/v1/customers?customerType=company", cookie);
    expect(byType.json().meta.total).toBe(1);
    expect(byType.json().data[0].nickname).toBe("企业客户");

    const byTag = await get("/api/v1/customers?tag=vip", cookie);
    expect(byTag.json().meta.total).toBe(1);
    expect((await get("/api/v1/customers?tag=ip", cookie)).json().meta.total).toBe(0);

    const byOwner = await get(`/api/v1/customers?ownerId=${u1}`, cookie);
    expect(byOwner.json().meta.total).toBe(1);
    expect((await get("/api/v1/customers?ownerId=9999", cookie)).json().meta.total).toBe(0);

    expect((await get("/api/v1/customers?customerType=bogus", cookie)).statusCode).toBe(422);
    expect((await get("/api/v1/customers?tag=bogus", cookie)).statusCode).toBe(422);
  });

  it("过滤 channelId：来源渠道包含该渠道即命中", async () => {
    const { cookie } = await loginAsRole("admin");
    const ch1 = seedChannel(tmp.db, "渠道一");
    const ch2 = seedChannel(tmp.db, "渠道二");
    await post("/api/v1/customers", cookie, { nickname: "来源客", sourceChannelIds: [ch1] });
    await post("/api/v1/customers", cookie, { nickname: "其它客", sourceChannelIds: [ch2] });

    const res = await get(`/api/v1/customers?channelId=${ch1}`, cookie);
    expect(res.json().meta.total).toBe(1);
    expect(res.json().data.map((c: { nickname: string }) => c.nickname)).toEqual(["来源客"]);
    expect((await get(`/api/v1/customers?channelId=${ch2}`, cookie)).json().meta.total).toBe(1);
  });

  it("sort=nickname asc 放行；默认 updatedAt desc + id DESC；非法 sort → 422", async () => {
    const { cookie } = await loginAsRole("admin");
    await post("/api/v1/customers", cookie, { nickname: "B客户" });
    await post("/api/v1/customers", cookie, { nickname: "A客户" });

    const asc = await get("/api/v1/customers?sort=nickname&order=asc", cookie);
    expect(asc.json().data.map((c: { nickname: string }) => c.nickname)).toEqual([
      "A客户",
      "B客户",
    ]);

    // 默认：同毫秒创建时 id DESC（后建在前）
    const dflt = await get("/api/v1/customers", cookie);
    expect(dflt.json().data[0].nickname).toBe("A客户");

    expect((await get("/api/v1/customers?sort=deletedAt", cookie)).statusCode).toBe(422);
  });

  it("list 项带完整 expansions（owner/tags/sourceChannels 形状正确），与 GET one 同形", async () => {
    const { cookie } = await loginAsRole("admin");
    const u1 = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    const ch1 = seedChannel(tmp.db, "渠道一");
    const created = await post("/api/v1/customers", cookie, {
      nickname: "全量客户",
      tagCodes: ["vip"],
      ownerId: u1,
      sourceChannelIds: [ch1],
    });
    const c = created.json().data;

    const list = (await get("/api/v1/customers", cookie)).json();
    const item = list.data.find((x: { id: number }) => x.id === c.id);
    expect(item.owner).toEqual({ id: u1, nickname: "一" });
    expect(item.tagCodes).toEqual(["vip"]);
    expect(item.sourceChannels).toEqual([{ id: ch1, name: "渠道一" }]);

    const one = (await get(`/api/v1/customers/${c.id}`, cookie)).json().data;
    expect(one).toEqual(item);
  });
});

describe("GET /api/v1/customers/:id", () => {
  it("camelCase 完整行，无 snake_case 泄漏、无 deletedAt；软删/不存在 → 404；非法 id → 422", async () => {
    const { cookie, data: c } = await createCustomerAsAdmin({
      phone: "1",
      wechatOpenid: "openid-x",
      tagCodes: ["vip"],
    });
    const res = await get(`/api/v1/customers/${c.id}`, cookie);
    expect(res.statusCode).toBe(200);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("real_name");
    expect(raw).not.toContain("wechat_openid");
    expect(raw).not.toContain("customer_type");
    expect(raw).not.toContain("created_at");
    expect(raw).not.toContain("deletedAt");
    expect(raw).not.toContain("deleted_at");

    expect((await get("/api/v1/customers/9999", cookie)).statusCode).toBe(404);
    expect((await get("/api/v1/customers/abc", cookie)).statusCode).toBe(422);

    await del(`/api/v1/customers/${c.id}`, cookie);
    expect((await get(`/api/v1/customers/${c.id}`, cookie)).statusCode).toBe(404);
  });
});

describe("DELETE /api/v1/customers/:id", () => {
  it("软删：204；重复删除/不存在 → 404；行与 join 行仍在库、owner_id 保留", async () => {
    const { cookie } = await loginAsRole("admin");
    const u1 = await seedUser(tmp.db, { username: "o1", nickname: "一" });
    const created = await post("/api/v1/customers", cookie, {
      nickname: "c",
      ownerId: u1,
      tagCodes: ["vip"],
    });
    const c = created.json().data;

    expect((await del(`/api/v1/customers/${c.id}`, cookie)).statusCode).toBe(204);
    expect((await del(`/api/v1/customers/${c.id}`, cookie)).statusCode).toBe(404);
    expect((await del("/api/v1/customers/9999", cookie)).statusCode).toBe(404);

    const row = tmp.sqlite
      .prepare("SELECT deleted_at FROM customers WHERE id = ?")
      .get(c.id) as { deleted_at: number };
    expect(row.deleted_at).toBe(clock.t);
    // K9：软删不剥 join 行，owner_id 也保留
    expect(ownerIdOf(c.id)).toBe(u1);
    expect(joinCount("customer_tags", c.id)).toBe(1);
  });
});
