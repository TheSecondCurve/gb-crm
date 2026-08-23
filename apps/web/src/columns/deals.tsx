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
import {
  centsToYuan,
  dateToEpochMs,
  enumBadge,
  epochMsToDate,
  formatDateTime,
  optionsOf,
  refName,
  yuanToCents,
  type BadgeTone,
} from "./common";
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

/**
 * 成交 POST/PATCH body 转换（行内编辑、新增/修改弹窗共用；DealsPage / MyDealsPage 唯一实现）：
 * - deliveryDate：YYYY-MM-DD → 本地时区零点 epoch ms；
 * - amountCents：元字符串 → 分整数（round，K13）；
 * - afterTaxRatio：字符串 → number。
 * 三者空值 = null（清空语义，schema nullable）；非空但转不出合法值 → 抛错（DataGrid 队列
 * onError / 弹窗 catch 统一 toast），禁止静默转 null 写库。
 */
export function convertDealBody(body: Record<string, unknown>): Record<string, unknown> {
  let next = body;
  if ("deliveryDate" in next) {
    const ms = dateToEpochMs(next.deliveryDate);
    if (ms === null && String(next.deliveryDate ?? "").trim() !== "") {
      throw new Error("交付日期需为 YYYY-MM-DD 格式");
    }
    next = { ...next, deliveryDate: ms };
  }
  if ("amountCents" in next) {
    const cents = yuanToCents(next.amountCents);
    if (cents === null && String(next.amountCents ?? "").trim() !== "") {
      throw new Error("金额需为数字（元）");
    }
    next = { ...next, amountCents: cents };
  }
  if ("afterTaxRatio" in next) {
    const s = String(next.afterTaxRatio ?? "").trim();
    const n = s === "" ? null : Number(s);
    if (n !== null && !Number.isFinite(n)) {
      throw new Error("税后金额比例需为数字");
    }
    next = { ...next, afterTaxRatio: n };
  }
  return next;
}

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
    {
      key: "amountCents",
      label: "金额（元）",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => centsToYuan(row.amountCents),
      render: (row) => centsToYuan(row.amountCents),
      applyOptimistic: (row, v) => ({ ...row, amountCents: yuanToCents(v) }),
    },
    {
      key: "afterTaxRatio",
      label: "税后金额比例",
      editor: "text",
      editable: canUpdate,
      getValue: (row) => (row.afterTaxRatio === null ? "" : String(row.afterTaxRatio)),
      render: (row) => (row.afterTaxRatio === null ? "" : String(row.afterTaxRatio)),
      applyOptimistic: (row, v) => {
        const s = String(v ?? "").trim();
        const n = s === "" ? null : Number(s);
        return { ...row, afterTaxRatio: n === null || !Number.isFinite(n) ? null : n };
      },
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
