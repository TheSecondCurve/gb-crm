// deals 列定义（docs/design.md Appendix B deals / K42）：单值 FK 客户/意向产品/负责人 +
// 阶段/订单号/交付日期/支付信息备注；客户城市只读展示。assistant 整表只读（deals update deny）。
// 交付日期展示/编辑为 YYYY-MM-DD，PATCH 前转 epoch ms（本地时区当天零点）。
import {
  can,
  dealStageLabels,
  type SystemRole,
} from "@gb-crm/shared";

import type { DealCustomerRefDto, DealDto, DealProductRefDto, UserRefDto } from "../api/types";
import type { GridColumn } from "../components/DataGrid/DataGrid";
import { dateToEpochMs, enumBadge, epochMsToDate, formatDateTime, optionsOf, refName, type BadgeTone } from "./common";
import {
  customerLabelCache,
  customerOptionsLoader,
  productLabelCache,
  productOptionsLoader,
  userLabelCache,
  userOptionsLoader,
} from "./relation";

// K42：交付日期 helper 已收敛到 common.tsx（K43 交付管理页复用）；此处 re-export 保持既有引用不变。
export { epochMsToDate, dateToEpochMs } from "./common";

const STAGE_TONES: Record<string, BadgeTone> = {
  paid: "accent",
  refunded: "muted",
  closed: "muted",
};

const makeCustomerRef = (id: number, nickname: string): DealCustomerRefDto => ({ id, nickname, city: null });
const makeProductRef = (id: number, name: string): DealProductRefDto => ({ id, name });
const makeUserRef = (id: number, nickname: string): UserRefDto => ({ id, nickname });

/** Appendix B deals 列规格；editable 由 can(role, …) 算好 */
export function dealColumns(role: SystemRole | null): GridColumn<DealDto>[] {
  const canUpdate = can(role, "deals", "update");

  return [
    {
      key: "customer",
      label: "客户",
      editor: "relation-one",
      editable: canUpdate,
      patchKey: "customerId",
      relationLoader: customerOptionsLoader,
      getValue: (row) => row.customer?.id ?? null,
      render: (row) => row.customer?.nickname ?? "—",
      applyOptimistic: (row, v) => {
        const id = typeof v === "number" ? v : null;
        return {
          ...row,
          customerId: id ?? row.customerId,
          customer:
            id === null
              ? null
              : makeCustomerRef(id, customerLabelCache.get(id) ?? row.customer?.nickname ?? `#${id}`),
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
      key: "owner",
      label: "负责人",
      editor: "relation-one",
      editable: canUpdate,
      patchKey: "ownerId",
      relationLoader: userOptionsLoader,
      getValue: (row) => row.owner?.id ?? null,
      render: (row) => row.owner?.nickname ?? "—",
      applyOptimistic: (row, v) => {
        const id = typeof v === "number" ? v : null;
        return {
          ...row,
          ownerId: id,
          owner:
            id === null
              ? null
              : makeUserRef(id, userLabelCache.get(id) ?? row.owner?.nickname ?? `#${id}`),
        };
      },
    },
    {
      key: "city",
      label: "客户城市",
      editable: false,
      render: (row) => row.customer?.city ?? "—",
    },
    {
      key: "stage",
      label: "阶段",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(dealStageLabels),
      render: (row) => enumBadge(dealStageLabels, STAGE_TONES)(row.stage),
    },
    { key: "orderNo", label: "订单号", editor: "text", editable: canUpdate },
    {
      key: "deliveryDate",
      label: "交付日期",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => epochMsToDate(row.deliveryDate),
      render: (row) => epochMsToDate(row.deliveryDate),
      applyOptimistic: (row, v) => ({ ...row, deliveryDate: dateToEpochMs(v) }),
    },
    { key: "paymentRemark", label: "支付信息备注", editor: "textarea", editable: canUpdate },
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
