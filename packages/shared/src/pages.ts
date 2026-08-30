// 页面注册表（前端功能级权限的单一来源）。
// 安全层仍是 acl.ts 的 can()（resource×action），这里只描述「页面」：
// - 每页声明查看所需的后端能力（列表页 list、详情页 read）；
// - 角色→页面允许清单存 system_configs（code='pageAccess'），只在 can() 允许集内收缩；
// - 详情型页面（menu=false）不单独配，跟随 parent 菜单页。
// 侧栏菜单、路由守卫、/ 默认落地页都从 PAGE_REGISTRY 推导，删除散落的手写判断。
import { can, type Action, type Resource } from "./acl.js";
import type { SystemRole } from "./enums.js";

/** 侧栏菜单分组顺序（渲染与排序用） */
export const PAGE_GROUPS = ["我的运营", "主数据", "运营流程", "系统", "业务设置"] as const;
export type PageGroup = (typeof PAGE_GROUPS)[number];

export interface PageDef {
  /** 稳定标识（存进 system_configs / 接口 / /auth/me.pages） */
  key: string;
  /** 前端路由 path */
  path: string;
  /** 中文菜单名 */
  label: string;
  group: PageGroup;
  /** 组内排序 */
  order: number;
  /** 是否出现在侧栏菜单（false = 详情型页面，随父页面进入） */
  menu: boolean;
  /** 详情页所属的菜单页 key（仅 menu=false 使用）；访问权跟随父页面 */
  parent?: string;
  /** 查看本页所需的后端能力（列表页 list，详情页 read） */
  required: { resource: Resource; action: Action };
}

export const PAGE_REGISTRY: readonly PageDef[] = [
  // ── 我的运营 ──
  { key: "my-customers", path: "/my/customers", label: "我的客户", group: "我的运营", order: 0, menu: true, required: { resource: "customers", action: "list" } },
  { key: "my-deals", path: "/my/deals", label: "我的成交", group: "我的运营", order: 1, menu: true, required: { resource: "deals", action: "list" } },
  // ── 主数据 ──
  { key: "customers", path: "/customers", label: "客户信息", group: "主数据", order: 0, menu: true, required: { resource: "customers", action: "list" } },
  { key: "customer-overview", path: "/customers/:id", label: "客户总览", group: "主数据", order: 1, menu: false, parent: "customers", required: { resource: "customers", action: "read" } },
  { key: "channels", path: "/channels", label: "渠道资产", group: "主数据", order: 2, menu: true, required: { resource: "channels", action: "list" } },
  { key: "products", path: "/products", label: "产品目录", group: "主数据", order: 3, menu: true, required: { resource: "products", action: "list" } },
  { key: "deals", path: "/deals", label: "成交记录", group: "主数据", order: 4, menu: true, required: { resource: "deals", action: "list" } },
  // ── 运营流程 ──
  { key: "deliveries", path: "/deliveries", label: "交付管理", group: "运营流程", order: 0, menu: true, required: { resource: "deliveries", action: "list" } },
  { key: "delivery-detail", path: "/deliveries/:id", label: "交付详情", group: "运营流程", order: 1, menu: false, parent: "deliveries", required: { resource: "deliveries", action: "read" } },
  { key: "delivery-circle", path: "/deliveries/:id/circle", label: "圈子工作台", group: "运营流程", order: 2, menu: false, parent: "deliveries", required: { resource: "deliveries", action: "read" } },
  { key: "delivery-gantt", path: "/deliveries/:id/gantt", label: "甘特图", group: "运营流程", order: 3, menu: false, parent: "deliveries", required: { resource: "deliveries", action: "read" } },
  { key: "delivery-matrix", path: "/deliveries/:id/matrix", label: "矩阵", group: "运营流程", order: 4, menu: false, parent: "deliveries", required: { resource: "deliveries", action: "read" } },
  { key: "delivery-types", path: "/delivery-types", label: "交付类型", group: "运营流程", order: 5, menu: true, required: { resource: "deliveries", action: "list" } },
  { key: "materials", path: "/materials", label: "资料专区", group: "运营流程", order: 6, menu: true, required: { resource: "materials", action: "list" } },
  // ── 系统 ──
  { key: "users", path: "/users", label: "团队成员", group: "系统", order: 0, menu: true, required: { resource: "users", action: "list" } },
  { key: "settings", path: "/settings", label: "系统设置", group: "系统", order: 1, menu: true, required: { resource: "jobs", action: "list" } },
  { key: "auth-tokens", path: "/tokens", label: "授权管理", group: "系统", order: 2, menu: true, required: { resource: "auth", action: "list" } },
  // ── 业务设置 ──
  { key: "business-settings", path: "/business-settings", label: "客户标签词表", group: "业务设置", order: 0, menu: true, required: { resource: "tags", action: "read" } },
];

export type PageKey = (typeof PAGE_REGISTRY)[number]["key"];

export const PAGE_REGISTRY_BY_KEY: Readonly<Record<PageKey, PageDef>> = Object.fromEntries(
  PAGE_REGISTRY.map((p) => [p.key, p]),
) as Record<PageKey, PageDef>;

/**
 * role 在 can() 下允许查看的全部「菜单页」key（硬下限；详情页不在此列，随父页面）。
 * role === null → []
 */
export function canAllowedPageKeys(role: SystemRole | null): PageKey[] {
  if (role === null) return [];
  return PAGE_REGISTRY.filter(
    (p) => p.menu && can(role, p.required.resource, p.required.action),
  ).map((p) => p.key);
}

/** 角色→菜单页允许清单（system_configs code='pageAccess' 的 JSON 形状） */
export type PageAccessConfig = Partial<Record<SystemRole, PageKey[]>>;

/**
 * 计算角色真正可见的菜单页：
 * - admin 固定全量（不参与配置，防锁死管理页）；
 * - 其余角色 = can() 允许集 ∩ 配置允许集（配置只能在 can() 内收缩，超发被忽略）；
 * - 配置缺席 = 不收缩（默认全量）。
 */
export function computeEffectivePages(
  role: SystemRole | null,
  config: PageAccessConfig | undefined,
): PageKey[] {
  if (role === null) return [];
  const allowed = canAllowedPageKeys(role);
  if (role === "admin") return allowed;
  const cfg = config?.[role];
  if (!cfg) return allowed;
  const allowedSet = new Set(allowed);
  return cfg.filter((k) => allowedSet.has(k));
}

/** 判断某页面（含详情页，走 parent / 自身）在给定有效菜单页集合内是否可访问 */
export function canAccessPageKey(
  role: SystemRole | null,
  pageKey: PageKey | string,
  effective: PageKey[],
): boolean {
  if (role === null) return false;
  const def = PAGE_REGISTRY_BY_KEY[pageKey as PageKey];
  if (!def) return false;
  const target = def.menu ? def.key : (def.parent ?? def.key);
  return effective.includes(target);
}

/** 把有效菜单页 key 按侧栏分组/组内序排列（用于菜单渲染与默认落地页） */
export function menuPagesSorted(allowedKeys: PageKey[]): PageDef[] {
  const set = new Set(allowedKeys);
  return PAGE_REGISTRY.filter((p) => p.menu && set.has(p.key)).sort(
    (a, b) => PAGE_GROUPS.indexOf(a.group) - PAGE_GROUPS.indexOf(b.group) || a.order - b.order,
  );
}
