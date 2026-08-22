// products 列定义（docs/design.md Appendix B products：冻结 name；K13 priceCents
// 展示/编辑为元，PATCH 前 Math.round(yuan*100) 转分）。assistant 整表只读（products update deny）。
import {
  can,
  productStatusLabels,
  productTypeLabels,
  type SystemRole,
} from "@gb-crm/shared";

import type { ProductDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import { badge, enumBadge, formatDateTime, optionsOf, refName, type BadgeTone } from "./common";

const STATUS_TONES: Record<string, BadgeTone> = {
  on_sale: "accent",
  off_sale: "muted",
};

const IS_PACKAGE_OPTIONS = [
  { value: "false", label: "否" },
  { value: "true", label: "是" },
];

/** 元文本 → 分（K13：必须 round，禁止不 round 直接乘）；空/非数 → null */
export function yuanToCents(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (s === "") return null;
  const yuan = Number(s);
  return Number.isFinite(yuan) ? Math.round(yuan * 100) : null;
}

/** 分 → 元展示文本（12345 → 123.45）；null → "" */
export function centsToYuan(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

/** Appendix B products 列规格 */
export function productColumns(role: SystemRole | null): GridColumn<ProductDto>[] {
  const canUpdate = can(role, "products", "update");

  return [
    { key: "name", label: "产品名称", editor: "text", editable: canUpdate },
    {
      key: "productType",
      label: "产品类型",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(productTypeLabels),
      render: (row) => enumBadge(productTypeLabels)(row.productType),
    },
    {
      key: "isPackage",
      label: "是否套餐",
      editor: "select",
      editable: canUpdate,
      options: IS_PACKAGE_OPTIONS,
      getValue: (row) => (row.isPackage ? "true" : "false"),
      render: (row) => badge(row.isPackage ? "是" : "否", row.isPackage ? "accent" : "plain"),
      applyOptimistic: (row, v) => ({ ...row, isPackage: v === "true" }),
    },
    {
      key: "status",
      label: "状态",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(productStatusLabels),
      render: (row) => enumBadge(productStatusLabels, STATUS_TONES)(row.status),
    },
    {
      key: "priceCents",
      label: "价格（元）",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => centsToYuan(row.priceCents),
      render: (row) => centsToYuan(row.priceCents),
      applyOptimistic: (row, v) => ({ ...row, priceCents: yuanToCents(v) }),
    },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row) => formatDateTime(row.updatedAt),
    },
    { key: "sopUrl", label: "SOP链接", editor: "text", editable: canUpdate },
    {
      key: "defaultTasks",
      label: "默认交付动作",
      editor: "textarea",
      editable: canUpdate,
      render: (row) => row.defaultTasks || "—",
    },
    {
      key: "packageIncludes",
      label: "套餐包含",
      editor: "textarea",
      editable: canUpdate,
    },
    {
      key: "deliveryCycle",
      label: "交付周期",
      editor: "text",
      editable: canUpdate,
    },
    { key: "notes", label: "备注", editor: "textarea", editable: canUpdate },
    { key: "id", label: "ID", editable: false },
    {
      key: "createdAt",
      label: "创建时间",
      editable: false,
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: "createdBy",
      label: "创建人",
      editable: false,
      render: (row) => refName(row.createdBy),
    },
    {
      key: "updatedBy",
      label: "最后修改人",
      editable: false,
      render: (row) => refName(row.updatedBy),
    },
  ];
}
