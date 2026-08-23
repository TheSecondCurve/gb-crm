// 圈子工作台客户表字段定义：展示列与导出 Excel 共用同一套 key
// （与 apps/api/src/modules/customers/export.ts 的 COLUMNS key 对齐，?fields= 直传）。
// 昵称为行头锁定列；默认勾选 = 原圈子页硬编码列。
import type { ReactNode } from "react";
import { customerTypeLabels, type CustomerType } from "@gb-crm/shared";

import type { CustomerDto } from "../api/types";
import { badge, enumBadge, formatDateTime, refName, type BadgeTone } from "./common";

/** K45 标签徽章按 scope 上色（与 columns/customers.tsx 一致） */
const TAG_SCOPE_TONES: Record<string, BadgeTone> = {
  identity: "accent",
  stage: "plain",
  interest: "accent",
  other: "muted",
};

export interface CircleCustomerField {
  key: string;
  label: string;
  /** 行头等不可隐藏 */
  locked?: boolean;
  render: (c: CustomerDto) => ReactNode;
}

export const circleCustomerFields: CircleCustomerField[] = [
  { key: "nickname", label: "客户", locked: true, render: (c) => c.nickname },
  { key: "realName", label: "真实姓名", render: (c) => c.realName || "—" },
  { key: "title", label: "称谓", render: (c) => c.title || "—" },
  { key: "phone", label: "手机号", render: (c) => c.phone || "—" },
  { key: "wechat", label: "微信号", render: (c) => c.wechat || "—" },
  { key: "city", label: "城市", render: (c) => c.city || "—" },
  { key: "customerType", label: "类型", render: (c) => enumBadge(customerTypeLabels)(c.customerType as CustomerType) },
  { key: "industry", label: "行业", render: (c) => c.industry || "—" },
  {
    key: "tags",
    label: "标签",
    render: (c) => (
      <span className="tag-list">
        {c.tags.map((t) => badge(t.name, TAG_SCOPE_TONES[t.scope] ?? "muted"))}
      </span>
    ),
  },
  { key: "country", label: "国家", render: (c) => c.country || "—" },
  { key: "originStory", label: "元故事", render: (c) => c.originStory || "—" },
  { key: "notes", label: "备注", render: (c) => c.notes || "—" },
  { key: "wechatOpenid", label: "OpenID", render: (c) => c.wechatOpenid || "—" },
  {
    key: "lastFollowedAt",
    label: "最近跟进",
    render: (c) => (c.lastFollowedAt ? formatDateTime(c.lastFollowedAt) : "—"),
  },
  {
    key: "sourceChannels",
    label: "来源渠道",
    render: (c) => c.sourceChannels.map((ch) => ch.name).join("、") || "—",
  },
  { key: "owner", label: "归属人", render: (c) => c.owner?.nickname ?? "—" },
  { key: "createdAt", label: "创建时间", render: (c) => formatDateTime(c.createdAt) },
  { key: "updatedAt", label: "更新时间", render: (c) => formatDateTime(c.updatedAt) },
  { key: "createdBy", label: "创建人", render: (c) => refName(c.createdBy) },
  { key: "updatedBy", label: "最后修改人", render: (c) => refName(c.updatedBy) },
];

/** 默认显示字段（昵称锁定 + 原圈子页硬编码列） */
export const DEFAULT_CIRCLE_CUSTOMER_FIELDS = [
  "nickname",
  "realName",
  "title",
  "phone",
  "wechat",
  "city",
  "customerType",
  "owner",
  "sourceChannels",
  "lastFollowedAt",
];

const FIELD_KEYS = new Set(circleCustomerFields.map((f) => f.key));

/** 读持久化的显隐配置：过滤无效 key、强制保留锁定列；无有效配置回退默认 */
export function loadCircleCustomerVisibleKeys(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const keys = (JSON.parse(raw) as unknown[]).filter(
        (k): k is string => typeof k === "string" && FIELD_KEYS.has(k),
      );
      if (keys.length > 0) {
        const locked = circleCustomerFields.filter((f) => f.locked).map((f) => f.key);
        return [...new Set([...locked, ...keys])];
      }
    }
  } catch {
    /* localStorage 不可用时用默认 */
  }
  return [...DEFAULT_CIRCLE_CUSTOMER_FIELDS];
}

export function saveCircleCustomerVisibleKeys(storageKey: string, keys: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(keys));
  } catch {
    /* ignore */
  }
}
