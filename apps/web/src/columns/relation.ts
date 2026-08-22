// relation 编辑器的选项 loader 与乐观更新助手。
// 选项来自 GET 轻量列表（pageSize=100 + q）；loader 同时缓存 id→label，
// 供乐观更新把 number[] 映射回 { id, nickname|name }[] 展示结构。
import type { ListEnvelope } from "@gb-crm/shared";

import { api, buildQuery } from "../api/client";
import type { RelationOption } from "../components/DataGrid/DataGrid";

export type RelationLoader = (search: string) => Promise<RelationOption[]>;

export const userLabelCache = new Map<number, string>();
export const channelLabelCache = new Map<number, string>();
export const customerLabelCache = new Map<number, string>();
export const productLabelCache = new Map<number, string>();
export const dealLabelCache = new Map<number, string>();

/** GET {path}?pageSize=100&q=… → RelationOption[]，并填充 label 缓存 */
export function createRelationLoader(
  path: string,
  labelOf: (item: Record<string, unknown>) => string,
  cache: Map<number, string>,
): RelationLoader {
  return async (search) => {
    const res = await api.get<ListEnvelope<Record<string, unknown>>>(
      `${path}${buildQuery({ pageSize: 100, q: search })}`,
    );
    return (res?.data ?? []).map((item) => {
      const option: RelationOption = { id: Number(item.id), label: labelOf(item) };
      cache.set(option.id, option.label);
      return option;
    });
  };
}

export const userOptionsLoader: RelationLoader = createRelationLoader(
  "/users",
  (item) => String(item.nickname ?? item.id),
  userLabelCache,
);
export const channelOptionsLoader: RelationLoader = createRelationLoader(
  "/channels",
  (item) => String(item.name ?? item.id),
  channelLabelCache,
);
export const customerOptionsLoader: RelationLoader = createRelationLoader(
  "/customers",
  (item) => String(item.nickname ?? item.id),
  customerLabelCache,
);
export const productOptionsLoader: RelationLoader = createRelationLoader(
  "/products",
  (item) => String(item.name ?? item.id),
  productLabelCache,
);
/** 成交 ref 选项：订单号 · 客户昵称（K43 交付项创建时选成交） */
export const dealOptionsLoader: RelationLoader = createRelationLoader(
  "/deals",
  (item) => {
    const row = item as { orderNo?: unknown; customer?: { nickname?: string } | null };
    const orderNo = String(row.orderNo ?? "");
    const nickname = row.customer?.nickname ?? "";
    return `${orderNo}${orderNo && nickname ? " · " : ""}${nickname}`.trim() || `#${String(item.id)}`;
  },
  dealLabelCache,
);

/** relation 编辑初值：refs → number[] */
export function idsOf(refs: readonly { id: number }[]): number[] {
  return refs.map((r) => r.id);
}

/** relation 乐观更新：number[] → ref[]；label 优先行上已有 ref，其次 loader 缓存 */
export function applyRefs<R extends { id: number }>(
  prev: readonly R[],
  ids: unknown,
  cache: Map<number, string>,
  make: (id: number, label: string) => R,
): R[] {
  const list = Array.isArray(ids) ? ids.filter((v): v is number => typeof v === "number") : [];
  return list.map((id) => prev.find((r) => r.id === id) ?? make(id, cache.get(id) ?? `#${id}`));
}
