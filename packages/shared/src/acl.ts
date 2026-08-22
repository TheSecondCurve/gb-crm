import { z } from "zod";

import type { SystemRole } from "./enums.js";

export type { SystemRole } from "./enums.js";

export const resourceSchema = z.enum([
  "users",
  "channels",
  "products",
  "customers",
  "deals",
  "deliveries",
  "tags",
  "system",
  "jobs",
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
  "impersonate",
  "cancel",
  "cancelAny",
]);
export type Action = z.infer<typeof actionSchema>;

// 穷举矩阵（docs/design.md §6）；缺席 = deny。
// auth.setPassword = 改自己密码（PATCH /auth/password）；users.setPassword = 管理员设他人密码。
// auth.impersonate = 扮演用户（K49，仅 admin）：切换当前 cookie session 的身份，用于测试「我的运营」。
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
// K44：交付相关（类型/交付单/交付项/任务）统一归 deliveries 一个 resource
const ALL_DELIVERY_ACTIONS: readonly Action[] = ["list", "read", "create", "update", "delete"];
// K45：标签词表——admin 可维护，operator/assistant 只读（读词表用于筛选与总览页）
const ALL_TAG_ACTIONS: readonly Action[] = ["list", "read", "create", "update", "delete"];
// K46：系统配置（LLM 打标）——仅 admin
const SYSTEM_ACTIONS: readonly Action[] = ["read", "update"];
// K51：后台任务——全角色可创建/查看/取消自己的；取消他人任务需 cancelAny（仅 admin）。
// 任务数据全角色可见（内网、参数不敏感，非行级 ACL 收紧）；业务型权限按任务类型在创建时校验。
const ALL_JOB_ACTIONS: readonly Action[] = ["list", "read", "create", "cancel", "cancelAny"];

const MATRIX: Record<SystemRole, Readonly<Partial<Record<Resource, readonly Action[]>>>> = {
  admin: {
    users: ["list", "read", "create", "update", "delete", "updateRole", "setPassword"],
    channels: ALL_CHANNEL_ACTIONS,
    products: ALL_PRODUCT_ACTIONS,
    customers: ALL_CUSTOMER_ACTIONS,
    deals: ALL_DEAL_ACTIONS,
    deliveries: ALL_DELIVERY_ACTIONS,
    tags: ALL_TAG_ACTIONS,
    system: SYSTEM_ACTIONS,
    jobs: ALL_JOB_ACTIONS,
    // K49：扮演用户（act as user）仅 admin
    auth: ["setPassword", "impersonate"],
  },
  operator: {
    // users 全部写操作仅 admin（operator 只能 list/read）
    users: ["list", "read"],
    channels: ALL_CHANNEL_ACTIONS,
    products: ALL_PRODUCT_ACTIONS,
    customers: ALL_CUSTOMER_ACTIONS,
    deals: ALL_DEAL_ACTIONS,
    deliveries: ALL_DELIVERY_ACTIONS,
    tags: ["list", "read"],
    jobs: ["list", "read", "create", "cancel"],
    auth: ["setPassword"],
  },
  assistant: {
    // K31 锁定：assistant 不能 customers.create / customers.updateOwners
    // K27：assistant 不能 readChannelSecrets / updateChannelSecrets
    // K42/K44：成交与交付相关只读（list/read）
    customers: ["list", "read", "update"],
    channels: ["list", "read", "update"],
    products: ["list", "read"],
    deals: ["list", "read"],
    deliveries: ["list", "read"],
    tags: ["list", "read"],
    jobs: ["list", "read", "create", "cancel"],
    auth: ["setPassword"],
  },
};

/** 穷举矩阵；缺席 = deny。role===null → false（K23） */
export function can(role: SystemRole | null, resource: Resource, action: Action): boolean {
  if (role === null) return false;
  return MATRIX[role][resource]?.includes(action) ?? false;
}
