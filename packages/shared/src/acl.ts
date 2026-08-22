import { z } from "zod";

import type { SystemRole } from "./enums.js";

export type { SystemRole } from "./enums.js";

export const resourceSchema = z.enum([
  "users",
  "channels",
  "products",
  "customers",
  "deals",
  "deliverables",
  "auth",
]);
export type Resource = z.infer<typeof resourceSchema>;

export const actionSchema = z.enum([
  "list",
  "read",
  "create",
  "update",
  "delete",
  "updateRole",
  "setPassword",
  "updateOwners",
  "readChannelSecrets",
  "updateChannelSecrets",
]);
export type Action = z.infer<typeof actionSchema>;

// 穷举矩阵（docs/design.md §6）；缺席 = deny。
// auth.setPassword = 改自己密码（PATCH /auth/password）；users.setPassword = 管理员设他人密码。
const ALL_CHANNEL_ACTIONS: readonly Action[] = [
  "list",
  "read",
  "create",
  "update",
  "delete",
  "readChannelSecrets",
  "updateChannelSecrets",
];
const ALL_PRODUCT_ACTIONS: readonly Action[] = ["list", "read", "create", "update", "delete"];
const ALL_CUSTOMER_ACTIONS: readonly Action[] = [
  "list",
  "read",
  "create",
  "update",
  "delete",
  "updateOwners",
];
const ALL_DEAL_ACTIONS: readonly Action[] = ["list", "read", "create", "update", "delete"];
const ALL_DELIVERABLE_ACTIONS: readonly Action[] = ["list", "read", "create", "update", "delete"];

const MATRIX: Record<SystemRole, Readonly<Partial<Record<Resource, readonly Action[]>>>> = {
  admin: {
    users: ["list", "read", "create", "update", "delete", "updateRole", "setPassword"],
    channels: ALL_CHANNEL_ACTIONS,
    products: ALL_PRODUCT_ACTIONS,
    customers: ALL_CUSTOMER_ACTIONS,
    deals: ALL_DEAL_ACTIONS,
    deliverables: ALL_DELIVERABLE_ACTIONS,
    auth: ["setPassword"],
  },
  operator: {
    // users 全部写操作仅 admin（operator 只能 list/read）
    users: ["list", "read"],
    channels: ALL_CHANNEL_ACTIONS,
    products: ALL_PRODUCT_ACTIONS,
    customers: ALL_CUSTOMER_ACTIONS,
    deals: ALL_DEAL_ACTIONS,
    deliverables: ALL_DELIVERABLE_ACTIONS,
    auth: ["setPassword"],
  },
  assistant: {
    // K31 锁定：assistant 不能 customers.create / customers.updateOwners
    // K27：assistant 不能 readChannelSecrets / updateChannelSecrets
    // K42：assistant 对成交表只读（list/read）；K43：交付项同样只读
    customers: ["list", "read", "update"],
    channels: ["list", "read", "update"],
    products: ["list", "read"],
    deals: ["list", "read"],
    deliverables: ["list", "read"],
    auth: ["setPassword"],
  },
};

/** 穷举矩阵；缺席 = deny。role===null → false（K23） */
export function can(role: SystemRole | null, resource: Resource, action: Action): boolean {
  if (role === null) return false;
  return MATRIX[role][resource]?.includes(action) ?? false;
}
