// PR 12 导入测试：tmp-db 夹具 + 提交进仓库的脱敏 CSV fixture，不打网络。
// 覆盖：四表计数与 feishu_record_id、users 登录字段固定、二次幂等（UPSERT 不碰登录字段）、
// 软删复活、未知枚举回默认 + warn、join/parent_id 第二遍、找不到的 link warn、中文名映射抽查、
// 环/深度 parent 规则、飞书 API 分页（注入假 fetcher）。
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCsvDump } from "../scripts/import-csv.js";
import {
  importDump,
  type FeishuDump,
  type FeishuRecord,
} from "../scripts/import-core.js";
import { fetchFeishuDump, type Fetcher } from "../scripts/import-feishu.js";
import { createTmpDb, type TmpDb } from "./helpers/tmp-db.js";

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/feishu", import.meta.url));

let tmp: TmpDb;

beforeEach(() => {
  tmp = createTmpDb();
});

afterEach(() => {
  tmp.cleanup();
});

function all(table: string): Record<string, unknown>[] {
  return tmp.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

function byFeishuId(table: string, feishuRecordId: string): Record<string, unknown> {
  const row = tmp.sqlite
    .prepare(`SELECT * FROM ${table} WHERE feishu_record_id = ?`)
    .get(feishuRecordId) as Record<string, unknown> | undefined;
  expect(row, `${table} ${feishuRecordId} 应存在`).toBeTruthy();
  return row!;
}

function importFixture() {
  return importDump(tmp.sqlite, loadCsvDump(FIXTURE_DIR));
}

describe("fixture 首遍导入", () => {
  it("四表计数正确，feishu_record_id 落库", () => {
    const report = importFixture();
    expect(report.users).toMatchObject({ inserted: 3, updated: 0, skipped: 0 });
    expect(report.channels).toMatchObject({ inserted: 3, updated: 0, skipped: 0 });
    expect(report.products).toMatchObject({ inserted: 3, updated: 0, skipped: 0 });
    expect(report.customers).toMatchObject({ inserted: 3, updated: 0, skipped: 0 });

    expect(all("users")).toHaveLength(3);
    expect(all("channels")).toHaveLength(3);
    expect(all("products")).toHaveLength(3);
    expect(all("customers")).toHaveLength(3);
    for (const table of ["users", "channels", "products", "customers"]) {
      for (const row of all(table)) {
        expect(row.feishu_record_id).toMatch(/^rec_/);
      }
    }
  });

  it("INSERT 后 users 登录字段全 NULL / disabled；left 成员同样 disabled（K16）", () => {
    importFixture();
    for (const row of all("users")) {
      expect(row.username).toBeNull();
      expect(row.password_hash).toBeNull();
      expect(row.system_role).toBeNull();
      expect(row.account_status).toBe("disabled");
    }
    expect(byFeishuId("users", "rec_u2").employment_status).toBe("left");
    expect(byFeishuId("users", "rec_u2").account_status).toBe("disabled");
  });

  it("空昵称回默认名", () => {
    importFixture();
    expect(byFeishuId("users", "rec_u2").nickname).toBe("未命名成员");
    expect(byFeishuId("channels", "rec_c2").name).toBe("未命名渠道");
    expect(byFeishuId("products", "rec_p2").name).toBe("未命名产品");
    expect(byFeishuId("customers", "rec_k3").nickname).toBe("未命名客户");
  });

  it("未知枚举回 DEFAULT + warn 计数，行仍插入", () => {
    const report = importFixture();
    expect(byFeishuId("users", "rec_u3").job_title).toBe("other");
    expect(report.users.warn).toBe(1);
    expect(byFeishuId("channels", "rec_c2").platform).toBe("other");
    expect(report.channels.warn).toBe(1);
    expect(byFeishuId("customers", "rec_k3").customer_type).toBe("customer");
    expect(report.customers.warn).toBe(1);
  });

  it("价格：Math.round(yuan*100)，非数 NULL", () => {
    importFixture();
    expect(byFeishuId("products", "rec_p1").price_cents).toBe(19990);
    expect(byFeishuId("products", "rec_p2").price_cents).toBeNull();
    expect(byFeishuId("products", "rec_p3").price_cents).toBe(36500);
  });

  it("中文名映射抽查：状态/客户类型/平台/是否套餐/标签", () => {
    importFixture();
    expect(byFeishuId("users", "rec_u2").employment_status).toBe("left"); // 已离职
    expect(byFeishuId("users", "rec_u1").job_title).toBe("ops"); // 运营
    expect(byFeishuId("channels", "rec_c1").platform).toBe("xiaohongshu"); // 小红书
    expect(byFeishuId("channels", "rec_c3").account_type).toBe("wechat_group"); // 微信群
    expect(byFeishuId("products", "rec_p2").is_package).toBe(1); // 是
    expect(byFeishuId("products", "rec_p1").product_type).toBe("c_consulting"); // C端咨询
    expect(byFeishuId("customers", "rec_k1").customer_type).toBe("company"); // 企业
    expect(byFeishuId("customers", "rec_k2").customer_type).toBe("customer"); // 客户
    // 标签：VIP 直配；「业务阶段 1-10」带前缀与「1-10」无前缀都映射 stage_1_10
    const tags = all("customer_tags").map((r) => `${String(r.customer_id)}:${String(r.tag)}`);
    const k1 = byFeishuId("customers", "rec_k1").id;
    const k2 = byFeishuId("customers", "rec_k2").id;
    expect(tags).toContain(`${String(k1)}:vip`);
    expect(tags).toContain(`${String(k1)}:stage_1_10`);
    expect(tags).toContain(`${String(k2)}:stage_1_10`);
  });
});

describe("第二遍：join 与 parent_id", () => {
  it("join 表落对：成员侧/客户侧去重合并；找不到的 link warn 不失败", () => {
    const report = importFixture();
    const u1 = byFeishuId("users", "rec_u1").id;
    const u3 = byFeishuId("users", "rec_u3").id;
    const c1 = byFeishuId("channels", "rec_c1").id;
    const c3 = byFeishuId("channels", "rec_c3").id;
    const k1 = byFeishuId("customers", "rec_k1").id;
    const k2 = byFeishuId("customers", "rec_k2").id;
    const k3 = byFeishuId("customers", "rec_k3").id;

    // channel_owners：成员侧 rec_u1→rec_c1 与渠道侧 rec_c1→rec_u1 去重为一行；rec_c3 的 rec_u9 找不到
    expect(all("channel_owners")).toEqual([
      expect.objectContaining({ channel_id: c1, user_id: u1 }),
    ]);
    // customer_owners：负责的客户 rec_k1 ∪ 客户名单 rec_k1;rec_k2（去重）+ 客户侧归属人
    expect(all("customer_owners")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customer_id: k1, user_id: u1 }),
        expect.objectContaining({ customer_id: k2, user_id: u1 }),
      ]),
    );
    expect(all("customer_owners")).toHaveLength(2);
    // 升单人
    expect(all("customer_upsell_owners")).toEqual([
      expect.objectContaining({ customer_id: k2, user_id: u3 }),
    ]);
    // 来源渠道：rec_k2→rec_c1；rec_k3 的 rec_c9 找不到
    expect(all("customer_source_channels")).toEqual([
      expect.objectContaining({ customer_id: k2, channel_id: c1 }),
    ]);
    expect(all("customer_community_channels")).toEqual([]);

    // 找不到的 link：渠道负责人 rec_u9、客户父记录/社群/来源/归属人 rec_*9 → 仅 warn
    expect(report.relations.warn).toBe(5);
    expect(report.relations.messages.join("\n")).toContain("rec_u9");
    expect(report.relations.messages.join("\n")).toContain("rec_k9");
    expect(report.relations.messages.join("\n")).toContain("rec_c9");
    expect(byFeishuId("customers", "rec_k3").parent_id).toBeNull();
    expect(c3).toBeDefined();
    expect(k3).toBeDefined();
  });

  it("parent_id 第二遍落对", () => {
    const report = importFixture();
    expect(report.relations.parentsSet).toBe(1);
    expect(byFeishuId("customers", "rec_k2").parent_id).toBe(byFeishuId("customers", "rec_k1").id);
  });
});

describe("幂等与复活", () => {
  it("二次运行幂等：全走 UPSERT 分支，行数与关系不变", () => {
    importFixture();
    // updated_at 每次 UPSERT 都 bump（设计要求），幂等比较排除它
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "updated_at")));
    const snapshot = {
      users: strip(all("users")),
      channels: strip(all("channels")),
      products: strip(all("products")),
      customers: strip(all("customers")),
      channel_owners: all("channel_owners"),
      customer_owners: all("customer_owners"),
      customer_upsell_owners: all("customer_upsell_owners"),
      customer_source_channels: all("customer_source_channels"),
      customer_community_channels: all("customer_community_channels"),
      customer_tags: all("customer_tags"),
    };
    const second = importFixture();
    expect(second.users).toMatchObject({ inserted: 0, updated: 3 });
    expect(second.channels).toMatchObject({ inserted: 0, updated: 3 });
    expect(second.products).toMatchObject({ inserted: 0, updated: 3 });
    expect(second.customers).toMatchObject({ inserted: 0, updated: 3 });
    // joins 已存在 → INSERT OR IGNORE 不再新增
    expect(second.relations.joinsInserted).toBe(0);
    expect(strip(all("users"))).toEqual(snapshot.users);
    expect(strip(all("channels"))).toEqual(snapshot.channels);
    expect(strip(all("products"))).toEqual(snapshot.products);
    expect(strip(all("customers"))).toEqual(snapshot.customers);
    for (const table of [
      "channel_owners",
      "customer_owners",
      "customer_upsell_owners",
      "customer_source_channels",
      "customer_community_channels",
      "customer_tags",
    ] as const) {
      expect(all(table)).toEqual(snapshot[table]);
    }
  });

  it("UPSERT 更新业务列、不动登录字段", () => {
    importFixture();
    const u1 = byFeishuId("users", "rec_u1");
    // 模拟管理员已在 UI 里发了账号
    tmp.sqlite
      .prepare(
        "UPDATE users SET username = 'shan', password_hash = 'hash', system_role = 'operator', account_status = 'enabled' WHERE id = ?",
      )
      .run(u1.id);
    const second = importFixture();
    expect(second.users.updated).toBe(3);
    const after = byFeishuId("users", "rec_u1");
    expect(after.username).toBe("shan");
    expect(after.password_hash).toBe("hash");
    expect(after.system_role).toBe("operator");
    expect(after.account_status).toBe("enabled");
  });

  it("软删行被复活（deleted_at=NULL），且 feishu_record_id 软删期间仍占用", () => {
    importFixture();
    const k2 = byFeishuId("customers", "rec_k2");
    tmp.sqlite.prepare("UPDATE customers SET deleted_at = 1 WHERE id = ?").run(k2.id);
    const second = importFixture();
    expect(second.customers).toMatchObject({ inserted: 0, updated: 3 });
    expect(byFeishuId("customers", "rec_k2").deleted_at).toBeNull();
    expect(all("customers")).toHaveLength(3);
  });
});

describe("parent_id 环与深度（K15 同服务层规则）", () => {
  function customersDump(records: FeishuRecord[]): FeishuDump {
    return { users: [], channels: [], products: [], customers: records };
  }

  it("父子环：双向互指只保留先落的一条，第二条 skip+warn", () => {
    const report = importDump(
      tmp.sqlite,
      customersDump([
        { recordId: "rec_a", fields: { 客户昵称: "甲", 父记录: "rec_b" } },
        { recordId: "rec_b", fields: { 客户昵称: "乙", 父记录: "rec_a" } },
      ]),
    );
    const a = byFeishuId("customers", "rec_a");
    const b = byFeishuId("customers", "rec_b");
    expect(a.parent_id).toBe(b.id);
    expect(b.parent_id).toBeNull();
    expect(report.relations.warn).toBe(1);
    expect(report.relations.messages[0]).toContain("环");
  });

  it("深度 > 2：三层链的第三层 skip+warn", () => {
    const report = importDump(
      tmp.sqlite,
      customersDump([
        { recordId: "rec_a", fields: { 客户昵称: "企业" } },
        { recordId: "rec_b", fields: { 客户昵称: "下属", 父记录: "rec_a" } },
        { recordId: "rec_c", fields: { 客户昵称: "孙层", 父记录: "rec_b" } },
      ]),
    );
    expect(byFeishuId("customers", "rec_b").parent_id).toBe(byFeishuId("customers", "rec_a").id);
    expect(byFeishuId("customers", "rec_c").parent_id).toBeNull();
    expect(report.relations.warn).toBe(1);
    expect(report.relations.messages[0]).toContain("两层");
  });

  it("自指 skip+warn；缺 record id 的行 skipped", () => {
    const report = importDump(
      tmp.sqlite,
      customersDump([
        { recordId: "rec_a", fields: { 客户昵称: "甲", 父记录: "rec_a" } },
        { recordId: "", fields: { 客户昵称: "无ID" } },
      ]),
    );
    expect(byFeishuId("customers", "rec_a").parent_id).toBeNull();
    expect(report.relations.warn).toBe(1);
    expect(report.relations.messages[0]).toContain("自指");
    expect(report.customers.skipped).toBe(1);
    expect(all("customers")).toHaveLength(1);
  });
});

describe("飞书 API 网络层（注入假 fetcher，不打 live）", () => {
  it("tenant_access_token + 分页拉四表，fields 按中文名透传", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (url) => {
      calls.push(url);
      if (url.includes("tenant_access_token")) {
        return { status: 200, json: { code: 0, tenant_access_token: "t-token" } };
      }
      const tableIdMatch = /tables\/([^/]+)\/records/.exec(url);
      if (!tableIdMatch) throw new Error(`unexpected url ${url}`);
      const tableId = tableIdMatch[1]!;
      const pageToken = new URL(url).searchParams.get("page_token");
      if (pageToken === null) {
        return {
          status: 200,
          json: {
            code: 0,
            data: {
              has_more: true,
              page_token: "p2",
              items: [
                {
                  record_id: `rec_${tableId}_1`,
                  // 飞书 text 是段数组、link 是 record id 数组，原样透传给 core 归一化
                  fields: { 昵称: [{ type: "text", text: "阿珊" }] },
                },
              ],
            },
          },
        };
      }
      return {
        status: 200,
        json: {
          code: 0,
          data: {
            has_more: false,
            items: [{ record_id: `rec_${tableId}_2`, fields: { 昵称: "第二页" } }],
          },
        },
      };
    };

    const dump = await fetchFeishuDump(
      { appId: "cli_x", appSecret: "secret", baseToken: "base_token" },
      fetcher,
    );
    // 1 次 token + 4 表 × 2 页
    expect(calls).toHaveLength(9);
    expect(calls[0]).toContain("tenant_access_token");
    for (const key of ["users", "channels", "products", "customers"] as const) {
      expect(dump[key]).toHaveLength(2);
      expect(dump[key]![0]!.recordId).toMatch(/_1$/);
      expect(dump[key]![0]!.fields["昵称"]).toEqual([{ type: "text", text: "阿珊" }]);
    }
    // token 走 Authorization 头（间接验证：第二页请求带了 page_token）
    expect(calls.filter((u) => u.includes("page_token=p2"))).toHaveLength(4);
  });

  it("飞书 API 返回非 0 code → 抛错", async () => {
    const fetcher: Fetcher = async () => ({ status: 200, json: { code: 999, msg: "bad app" } });
    await expect(
      fetchFeishuDump({ appId: "x", appSecret: "y", baseToken: "z" }, fetcher),
    ).rejects.toThrow("999");
  });
});
