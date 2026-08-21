import { describe, expect, it } from "vitest";

import {
  actionSchema,
  can,
  resourceSchema,
  systemRoleSchema,
  type Action,
  type Resource,
  type SystemRole,
} from "../src/index";

// 期望矩阵，直接照抄 docs/design.md §6 表格（与实现分开维护，防止同步抄错）。
const EXPECTED: Record<SystemRole, Partial<Record<Resource, readonly Action[]>>> = {
  admin: {
    users: ["list", "read", "create", "update", "delete", "updateRole", "setPassword"],
    channels: [
      "list",
      "read",
      "create",
      "update",
      "delete",
      "readChannelSecrets",
      "updateChannelSecrets",
    ],
    products: ["list", "read", "create", "update", "delete"],
    customers: ["list", "read", "create", "update", "delete", "updateOwners"],
    auth: ["setPassword"],
  },
  operator: {
    users: ["list", "read"],
    channels: [
      "list",
      "read",
      "create",
      "update",
      "delete",
      "readChannelSecrets",
      "updateChannelSecrets",
    ],
    products: ["list", "read", "create", "update", "delete"],
    customers: ["list", "read", "create", "update", "delete", "updateOwners"],
    auth: ["setPassword"],
  },
  assistant: {
    customers: ["list", "read", "update"],
    channels: ["list", "read", "update"],
    products: ["list", "read"],
    auth: ["setPassword"],
  },
};

const ROLES: (SystemRole | null)[] = [...systemRoleSchema.options, null];

describe("can() 矩阵逐格", () => {
  it("每个 role × resource × action 与 §6 表格一致（缺席 = deny）", () => {
    for (const role of ROLES) {
      for (const resource of resourceSchema.options) {
        for (const action of actionSchema.options) {
          const expected =
            role !== null && (EXPECTED[role][resource]?.includes(action) ?? false);
          expect(
            can(role, resource, action),
            `can(${role}, ${resource}, ${action})`,
          ).toBe(expected);
        }
      }
    }
  });

  it("null role 全 false（K23）", () => {
    for (const resource of resourceSchema.options) {
      for (const action of actionSchema.options) {
        expect(can(null, resource, action)).toBe(false);
      }
    }
  });
});

// §6 必测场景对应的 can() 断言（HTTP 层 403/null 在 API PR 中验证）
describe("§6 必测场景", () => {
  it("assistant PATCH product → deny", () => {
    expect(can("assistant", "products", "update")).toBe(false);
  });

  it("assistant POST customer → deny（K31）", () => {
    expect(can("assistant", "customers", "create")).toBe(false);
  });

  it("assistant PATCH customer 普通字段 → allow", () => {
    expect(can("assistant", "customers", "update")).toBe(true);
  });

  it("assistant PATCH customer ownerIds → deny（K31）", () => {
    expect(can("assistant", "customers", "updateOwners")).toBe(false);
  });

  it("assistant GET channel secrets → deny（K27）", () => {
    expect(can("assistant", "channels", "readChannelSecrets")).toBe(false);
    expect(can("assistant", "channels", "updateChannelSecrets")).toBe(false);
  });

  it("null role（system_role NULL）→ 全 deny", () => {
    expect(can(null, "customers", "list")).toBe(false);
    expect(can(null, "auth", "setPassword")).toBe(false);
  });

  it("auth 改自己密码三角色都可以", () => {
    for (const role of systemRoleSchema.options) {
      expect(can(role, "auth", "setPassword")).toBe(true);
    }
  });

  it("operator users 只能 list/read，写操作仅 admin", () => {
    for (const action of ["create", "update", "delete", "updateRole", "setPassword"] as const) {
      expect(can("admin", "users", action)).toBe(true);
      expect(can("operator", "users", action)).toBe(false);
      expect(can("assistant", "users", action)).toBe(false);
    }
  });
});
