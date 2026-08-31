import { describe, expect, it } from "vitest";

import {
  channelListQuerySchema,
  channelPatchSchema,
  customerListQuerySchema,
  customerPatchSchema,
  materialListQuerySchema,
  materialPatchSchema,
  materialWriteSchema,
  maintenanceRecordListQuerySchema,
  maintenanceRecordPatchSchema,
  maintenanceRecordWriteSchema,
  mintTokenSchema,
  pageQuerySchema,
  productListQuerySchema,
  productPatchSchema,
  userListQuerySchema,
  userPatchSchema,
} from "../src/index";

describe("pageQuerySchema", () => {
  it("默认值 page=1 / pageSize=25", () => {
    const r = pageQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(25);
    expect(r.q).toBeUndefined();
    expect(r.order).toBeUndefined();
  });

  it("query string 可 coerce", () => {
    const r = pageQuerySchema.parse({ page: "2", pageSize: "50", q: " 闪 ", order: "asc" });
    expect(r).toEqual({ page: 2, pageSize: 50, q: "闪", order: "asc" });
  });

  it("pageSize 上限 100、page 下限 1", () => {
    expect(pageQuerySchema.safeParse({ pageSize: 100 }).success).toBe(true);
    expect(pageQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ pageSize: 0 }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe("list query：camelCase + 每资源独立 sort enum", () => {
  it("camelCase 过滤参数", () => {
    expect(
      userListQuerySchema.parse({ systemRole: "assistant", accountStatus: "enabled" }),
    ).toMatchObject({ systemRole: "assistant", accountStatus: "enabled" });
    expect(
      channelListQuerySchema.parse({ platform: "wechat", channelType: "private" }),
    ).toMatchObject({ platform: "wechat", channelType: "private" });
    expect(
      customerListQuerySchema.parse({ ownerId: "3", channelId: "7" }),
    ).toMatchObject({ ownerId: 3, channelId: 7 });
    expect(productListQuerySchema.parse({ isPackage: "true" })).toMatchObject({
      isPackage: true,
    });
    expect(productListQuerySchema.parse({ isPackage: "false" })).toMatchObject({
      isPackage: false,
    });
  });

  it("sort 接受本资源字段", () => {
    expect(userListQuerySchema.parse({ sort: "username" }).sort).toBe("username");
    expect(channelListQuerySchema.parse({ sort: "name" }).sort).toBe("name");
    expect(productListQuerySchema.parse({ sort: "priceCents" }).sort).toBe("priceCents");
    expect(customerListQuerySchema.parse({ sort: "nickname" }).sort).toBe("nickname");
  });

  it("sort 拒绝跨资源字段", () => {
    // nickname 是 users/customers 的，不是 products/channels 的
    expect(productListQuerySchema.safeParse({ sort: "nickname" }).success).toBe(false);
    expect(channelListQuerySchema.safeParse({ sort: "nickname" }).success).toBe(false);
    // name 不是 users/customers 的；priceCents 只属于 products
    expect(userListQuerySchema.safeParse({ sort: "name" }).success).toBe(false);
    expect(customerListQuerySchema.safeParse({ sort: "priceCents" }).success).toBe(false);
  });
});

describe("patch schema（K24：键可缺席，不得绑默认值）", () => {
  it("缺席键通过，且解析结果不带默认值键", () => {
    const r = customerPatchSchema.parse({ updatedAt: 1724000000000 });
    expect(r.updatedAt).toBe(1724000000000);
    expect("customerType" in r).toBe(false);
    expect("nickname" in r).toBe(false);
    expect("ownerId" in r).toBe(false);
  });

  it("{ ownerId: null } 通过（单值归属人 null = 清空；channel 关系 [] = 清空）", () => {
    expect(customerPatchSchema.parse({ ownerId: null, updatedAt: 1 }).ownerId).toBeNull();
    expect(channelPatchSchema.parse({ ownerIds: [], updatedAt: 1 }).ownerIds).toEqual([]);
  });

  it("显式 null 清空可空标量", () => {
    expect(customerPatchSchema.parse({ realName: null, updatedAt: 1 }).realName).toBeNull();
    expect(customerPatchSchema.parse({ lastFollowedAt: null, updatedAt: 1 }).lastFollowedAt).toBeNull();
    expect(productPatchSchema.parse({ priceCents: null, updatedAt: 1 }).priceCents).toBeNull();
  });

  it("缺 updatedAt 失败", () => {
    expect(customerPatchSchema.safeParse({ nickname: "x" }).success).toBe(false);
    expect(userPatchSchema.safeParse({}).success).toBe(false);
    expect(channelPatchSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(productPatchSchema.safeParse({}).success).toBe(false);
  });

  it("priceCents 非整数失败（K13）", () => {
    expect(productPatchSchema.safeParse({ priceCents: 19.9, updatedAt: 1 }).success).toBe(false);
    expect(productPatchSchema.safeParse({ priceCents: "100", updatedAt: 1 }).success).toBe(false);
    expect(productPatchSchema.parse({ priceCents: 1990, updatedAt: 1 }).priceCents).toBe(1990);
  });

  it("枚举值校验与关系数组校验", () => {
    expect(
      customerPatchSchema.safeParse({ customerType: "vip", updatedAt: 1 }).success,
    ).toBe(false);
    expect(
      customerPatchSchema.parse({
        socialAccounts: [
          { platform: "xiaohongshu", account: "xhs-id" },
          { platform: "weibo", account: "wb" },
        ],
        updatedAt: 1,
      }).socialAccounts,
    ).toEqual([
      { platform: "xiaohongshu", account: "xhs-id" },
      { platform: "weibo", account: "wb" },
    ]);
    expect(
      customerPatchSchema.safeParse({
        socialAccounts: [{ platform: "bilibili", account: "x" }],
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      customerPatchSchema.safeParse({
        socialAccounts: [{ platform: "weibo", account: "" }],
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      customerPatchSchema.safeParse({ ownerId: 1.5, updatedAt: 1 }).success,
    ).toBe(false);
  });
});

describe("material schemas（K54）", () => {
  it("文本类 content 可空（后补）；媒体类 url 必填", () => {
    const base = { title: "咨询记录" };
    expect(
      materialWriteSchema.safeParse({ ...base, kind: "transcript", content: "语料全文" }).success,
    ).toBe(true);
    expect(materialWriteSchema.safeParse({ ...base, kind: "transcript" }).success).toBe(true);
    expect(materialWriteSchema.safeParse({ ...base, kind: "text", content: null }).success).toBe(
      true,
    );
    expect(materialWriteSchema.safeParse({ ...base, kind: "text", content: "  " }).success).toBe(
      true,
    );
    expect(
      materialWriteSchema.safeParse({ ...base, kind: "audio", url: "https://x/a.mp3" }).success,
    ).toBe(true);
    expect(materialWriteSchema.safeParse({ ...base, kind: "audio" }).success).toBe(false);
    expect(materialWriteSchema.safeParse({ ...base, kind: "link" }).success).toBe(false);
  });

  it("关联可空（孤儿允许）：deliveryId nullish、customerIds 可缺席", () => {
    expect(
      materialWriteSchema.safeParse({ title: "孤儿", kind: "text", content: "x" }).success,
    ).toBe(true);
    expect(
      materialWriteSchema.parse({
        title: "x",
        kind: "video",
        url: "https://x/v.mp4",
        deliveryId: null,
        customerIds: [],
      }),
    ).toMatchObject({ deliveryId: null, customerIds: [] });
  });

  it("patch：键可缺席不绑默认值；缺 updatedAt 失败；显式 null 清空 deliveryId", () => {
    const r = materialPatchSchema.parse({ updatedAt: 1 });
    expect("kind" in r).toBe(false);
    expect("content" in r).toBe(false);
    expect(materialPatchSchema.safeParse({ title: "x" }).success).toBe(false);
    expect(materialPatchSchema.parse({ deliveryId: null, updatedAt: 1 }).deliveryId).toBeNull();
    expect(materialPatchSchema.parse({ customerIds: [], updatedAt: 1 }).customerIds).toEqual([]);
  });

  it("list query：camelCase 过滤 + orphan", () => {
    expect(
      materialListQuerySchema.parse({ kind: "audio", deliveryId: "3", customerId: "7" }),
    ).toMatchObject({ kind: "audio", deliveryId: 3, customerId: 7 });
    expect(materialListQuerySchema.parse({ orphan: "1" }).orphan).toBe("1");
    expect(materialListQuerySchema.safeParse({ orphan: "true" }).success).toBe(false);
    expect(materialListQuerySchema.parse({ sort: "title" }).sort).toBe("title");
    expect(materialListQuerySchema.safeParse({ sort: "nickname" }).success).toBe(false);
  });
});

describe("maintenance record schemas（K55）", () => {
  it("write：kind/happenedAt 必填；content 可空", () => {
    expect(
      maintenanceRecordWriteSchema.safeParse({ kind: "follow_up", happenedAt: 1724000000000 }).success,
    ).toBe(true);
    expect(
      maintenanceRecordWriteSchema.parse({
        kind: "lead",
        happenedAt: 1,
        content: "对 1v1 咨询感兴趣",
      }).content,
    ).toBe("对 1v1 咨询感兴趣");
    expect(maintenanceRecordWriteSchema.safeParse({ happenedAt: 1 }).success).toBe(false);
    expect(maintenanceRecordWriteSchema.safeParse({ kind: "follow_up" }).success).toBe(false);
  });

  it("write：kind 枚举拒绝非法值；content 可为 null", () => {
    expect(maintenanceRecordWriteSchema.safeParse({ kind: "vip", happenedAt: 1 }).success).toBe(
      false,
    );
    expect(maintenanceRecordWriteSchema.parse({ kind: "note", happenedAt: 1, content: null }).content).toBeNull();
  });

  it("patch：键可缺席不绑默认值；缺 updatedAt 失败", () => {
    const r = maintenanceRecordPatchSchema.parse({ updatedAt: 1 });
    expect("kind" in r).toBe(false);
    expect("happenedAt" in r).toBe(false);
    expect("content" in r).toBe(false);
    expect(maintenanceRecordPatchSchema.safeParse({ kind: "note" }).success).toBe(false);
  });

  it("list query：camelCase 过滤 + 本资源 sort", () => {
    expect(
      maintenanceRecordListQuerySchema.parse({ kind: "lead", sort: "happenedAt" }),
    ).toMatchObject({ kind: "lead", sort: "happenedAt" });
    expect(maintenanceRecordListQuerySchema.parse({ sort: "createdAt" }).sort).toBe("createdAt");
    expect(maintenanceRecordListQuerySchema.parse({ sort: "updatedAt" }).sort).toBe("updatedAt");
    expect(maintenanceRecordListQuerySchema.safeParse({ sort: "nickname" }).success).toBe(false);
  });
});

describe("mintTokenSchema", () => {
  it("接受 read/write，name 可缺席", () => {
    expect(mintTokenSchema.parse({ username: "a", password: "p", scope: "read" })).toEqual({
      username: "a",
      password: "p",
      scope: "read",
    });
    expect(
      mintTokenSchema.parse({ username: "a", password: "p", scope: "write", name: "mba" }),
    ).toMatchObject({ scope: "write", name: "mba" });
  });

  it("拒绝非法 scope / 空用户名 / 超长 name", () => {
    expect(mintTokenSchema.safeParse({ username: "a", password: "p", scope: "admin" }).success).toBe(
      false,
    );
    expect(mintTokenSchema.safeParse({ username: "", password: "p", scope: "read" }).success).toBe(
      false,
    );
    expect(
      mintTokenSchema.safeParse({
        username: "a",
        password: "p",
        scope: "read",
        name: "x".repeat(65),
      }).success,
    ).toBe(false);
  });
});
