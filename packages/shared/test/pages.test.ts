import { describe, expect, it } from "vitest";

import {
  canAccessPageKey,
  canAllowedPageKeys,
  computeEffectivePages,
  menuPagesSorted,
  PAGE_GROUPS,
  type PageKey,
} from "../src/index";

describe("canAllowedPageKeys（安全层 can() 允许的菜单页）", () => {
  it("null role → []", () => {
    expect(canAllowedPageKeys(null)).toEqual([]);
  });

  it("admin 包含全部菜单页；assistant 不含 users", () => {
    const admin = canAllowedPageKeys("admin");
    expect(admin).toContain("users");
    expect(admin).toContain("deliveries");
    expect(admin).toContain("business-settings");

    const assistant = canAllowedPageKeys("assistant");
    expect(assistant).not.toContain("users");
    expect(assistant).toContain("channels");
  });
});

describe("computeEffectivePages（配置 ∩ can() 允许集）", () => {
  it("配置缺席 → 不收缩（等于 can() 允许集）", () => {
    expect(computeEffectivePages("operator", undefined)).toEqual(canAllowedPageKeys("operator"));
    expect(computeEffectivePages("assistant", {})).toEqual(canAllowedPageKeys("assistant"));
  });

  it("admin 固定全量，忽略配置（防锁死）", () => {
    const config = { admin: ["my-customers"] };
    expect(computeEffectivePages("admin", config)).toEqual(canAllowedPageKeys("admin"));
  });

  it("配置只在本角色允许集内收缩", () => {
    const out = computeEffectivePages("assistant", {
      assistant: ["my-customers", "users"], // users 不在 assistant 允许集 → 被滤掉
    });
    expect(out).toEqual(["my-customers"]);
  });

  it("空配置切片 → 空", () => {
    expect(computeEffectivePages("operator", { operator: [] })).toEqual([]);
  });
});

describe("canAccessPageKey（含详情页 parent 跟随）", () => {
  it("菜单页按自身 key；详情页按 parent", () => {
    const effective = ["customers", "deliveries"] as PageKey[];
    expect(canAccessPageKey("admin", "customers", effective)).toBe(true);
    expect(canAccessPageKey("admin", "customer-overview", effective)).toBe(true); // parent=customers
    expect(canAccessPageKey("admin", "delivery-circle", effective)).toBe(true); // parent=deliveries
    expect(canAccessPageKey("admin", "channels", effective)).toBe(false); // 不在有效集
  });

  it("null role / 未知 key → false", () => {
    expect(canAccessPageKey(null, "customers", ["customers"])).toBe(false);
    expect(canAccessPageKey("admin", "nope", ["customers"])).toBe(false);
  });
});

describe("menuPagesSorted（分组 + 组内序）", () => {
  it("按 PAGE_GROUPS 顺序、组内 order 排序", () => {
    const keys = ["users", "my-customers", "customers", "deliveries"] as PageKey[];
    const sorted = menuPagesSorted(keys);
    expect(sorted.map((p) => p.key)).toEqual(["my-customers", "customers", "deliveries", "users"]);
    // group 顺序与 PAGE_GROUPS 一致
    const groupIdx = sorted.map((p) => PAGE_GROUPS.indexOf(p.group));
    expect(groupIdx).toEqual([...groupIdx].sort((a, b) => a - b));
  });
});
