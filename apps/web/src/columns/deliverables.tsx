// deliverables 列定义（docs/design.md Appendix B deliverables / K43）：成交（relation-one，
// 显示订单号·客户昵称）/意向产品（relation-one）可编；状态/计划/实际/有效期可编；动作进度只读。
// assistant 整表只读（deliverables update deny）。
import { can, deliverableStatusLabels, type SystemRole } from "@gb-crm/shared";

import type { DeliverableDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import { badge, dateToEpochMs, enumBadge, epochMsToDate, formatDateTime, optionsOf, refName, type BadgeTone } from "./common";
import { dealLabelCache, dealOptionsLoader, productLabelCache, productOptionsLoader } from "./relation";

const STATUS_TONES: Record<string, BadgeTone> = {
  delivered: "accent",
  cancelled: "muted",
  delivering: "plain",
};

const makeProductRef = (id: number, name: string): DeliverableDto["product"] => ({ id, name });

/** 动作进度：已打勾/总数；全部完成 → accent */
export function taskProgress(d: DeliverableDto): { done: number; total: number; allDone: boolean } {
  const total = d.tasks.length;
  const done = d.tasks.filter((t) => t.done).length;
  return { done, total, allDone: total > 0 && done === total };
}

export function renderTaskProgress(d: DeliverableDto): React.ReactNode {
  const { done, total, allDone } = taskProgress(d);
  if (total === 0) return "—";
  return badge(`${done}/${total}`, allDone ? "accent" : "plain");
}

/** Appendix B deliverables 列规格；editable 由 can(role, …) 算好 */
export function deliverableColumns(role: SystemRole | null): GridColumn<DeliverableDto>[] {
  const canUpdate = can(role, "deliverables", "update");

  return [
    {
      key: "deal",
      label: "成交",
      editor: "relation-one",
      editable: canUpdate,
      patchKey: "dealId",
      relationLoader: dealOptionsLoader,
      getValue: (row) => row.deal?.id ?? null,
      render: (row) =>
        row.deal
          ? `${row.deal.orderNo ?? ""}${row.deal.orderNo && row.deal.customer ? " · " : ""}${row.deal.customer?.nickname ?? ""}`.trim() || `#${row.deal.id}`
          : "—",
      applyOptimistic: (row, v) => {
        const id = typeof v === "number" ? v : null;
        const label = id === null ? null : dealLabelCache.get(id);
        return {
          ...row,
          dealId: id ?? row.dealId,
          deal:
            id === null
              ? null
              : {
                  id,
                  orderNo: row.deal?.id === id ? row.deal.orderNo : null,
                  customer:
                    row.deal?.id === id
                      ? row.deal.customer
                      : { id, nickname: label ?? row.deal?.customer?.nickname ?? `#${id}` },
                },
        };
      },
    },
    {
      key: "product",
      label: "意向产品",
      editor: "relation-one",
      editable: canUpdate,
      patchKey: "productId",
      relationLoader: productOptionsLoader,
      getValue: (row) => row.product?.id ?? null,
      render: (row) => row.product?.name ?? "—",
      applyOptimistic: (row, v) => {
        const id = typeof v === "number" ? v : null;
        return {
          ...row,
          productId: id,
          product:
            id === null
              ? null
              : makeProductRef(id, productLabelCache.get(id) ?? row.product?.name ?? `#${id}`),
        };
      },
    },
    {
      key: "status",
      label: "状态",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(deliverableStatusLabels),
      render: (row) => enumBadge(deliverableStatusLabels, STATUS_TONES)(row.status),
    },
    {
      key: "taskProgress",
      label: "动作进度",
      editable: false,
      render: (row) => renderTaskProgress(row),
    },
    {
      key: "planDeliverDate",
      label: "计划交付日期",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => epochMsToDate(row.planDeliverDate),
      render: (row) => epochMsToDate(row.planDeliverDate),
      applyOptimistic: (row, v) => ({ ...row, planDeliverDate: dateToEpochMs(v) }),
    },
    {
      key: "actualDeliverDate",
      label: "实际交付日期",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => epochMsToDate(row.actualDeliverDate),
      render: (row) => epochMsToDate(row.actualDeliverDate),
      applyOptimistic: (row, v) => ({ ...row, actualDeliverDate: dateToEpochMs(v) }),
    },
    {
      key: "expiryDate",
      label: "有效期",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => epochMsToDate(row.expiryDate),
      render: (row) => epochMsToDate(row.expiryDate),
      applyOptimistic: (row, v) => ({ ...row, expiryDate: dateToEpochMs(v) }),
    },
    { key: "deliveryUrl", label: "交付物链接", editor: "text", editable: canUpdate },
    { key: "description", label: "交付说明", editor: "textarea", editable: canUpdate },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row) => formatDateTime(row.updatedAt),
    },
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
