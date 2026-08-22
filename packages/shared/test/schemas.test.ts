import { describe, expect, it } from "vitest";

import {
  channelListQuerySchema,
  channelPatchSchema,
  customerListQuerySchema,
  customerPatchSchema,
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
      customerListQuerySchema.parse({ ownerId: "3", channelId: "7", tag: "vip" }),
    ).toMatchObject({ ownerId: 3, channelId: 7, tag: "vip" });
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
    expect("ownerIds" in r).toBe(false);
  });

  it("{ ownerIds: [] } 通过（关系 [] = 清空）", () => {
    expect(customerPatchSchema.parse({ ownerIds: [], updatedAt: 1 }).ownerIds).toEqual([]);
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
      customerPatchSchema.parse({ tagCodes: ["vip", "stage_0_1"], updatedAt: 1 }).tagCodes,
    ).toEqual(["vip", "stage_0_1"]);
    expect(
      customerPatchSchema.safeParse({ tagCodes: ["nope"], updatedAt: 1 }).success,
    ).toBe(false);
    expect(
      customerPatchSchema.safeParse({ ownerIds: [1.5], updatedAt: 1 }).success,
    ).toBe(false);
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
