// 成交记录多维筛选条（成交记录页 / 我的成交页共用）：
// 客户、负责人（showOwner=false 时隐藏）、客户归属人三个 EntityPicker 单选 +
// 成交日期/交付日期范围（type=date，查询时转 epoch ms，end 含当日尾）+ 交付日期空否。
import { dateToEpochMs } from "../columns/common";
import {
  customerLabelCache,
  customerOptionsLoader,
  userLabelCache,
  userOptionsLoader,
} from "../columns/relation";
import { EntityPicker } from "./EntityPicker";

export interface DealFilterValues {
  customerId: number | null;
  ownerId: number | null;
  customerOwnerId: number | null;
  /** YYYY-MM-DD 本地态（输入框原始值），空串 = 不筛 */
  startDate: string;
  endDate: string;
  deliveryStartDate: string;
  deliveryEndDate: string;
  /** "" = 全部；empty = 未填；notEmpty = 已填 */
  deliveryStatus: string;
}

export const EMPTY_DEAL_FILTERS: DealFilterValues = {
  customerId: null,
  ownerId: null,
  customerOwnerId: null,
  startDate: "",
  endDate: "",
  deliveryStartDate: "",
  deliveryEndDate: "",
  deliveryStatus: "",
};

const DAY_TAIL_MS = 86399999; // 当日 23:59:59.999（end 含当天）

/** 筛选值 → GET /deals query 参数（undefined 由 buildQuery 跳过） */
export function dealFiltersToQuery(
  f: DealFilterValues,
): Record<string, string | number | undefined> {
  const end = dateToEpochMs(f.endDate);
  const deliveryEnd = dateToEpochMs(f.deliveryEndDate);
  return {
    customerId: f.customerId ?? undefined,
    ownerId: f.ownerId ?? undefined,
    customerOwnerId: f.customerOwnerId ?? undefined,
    startDate: dateToEpochMs(f.startDate) ?? undefined,
    endDate: end === null ? undefined : end + DAY_TAIL_MS,
    deliveryStartDate: dateToEpochMs(f.deliveryStartDate) ?? undefined,
    deliveryEndDate: deliveryEnd === null ? undefined : deliveryEnd + DAY_TAIL_MS,
    deliveryStatus: f.deliveryStatus || undefined,
  };
}

interface DealFilterBarProps {
  value: DealFilterValues;
  onChange: (next: DealFilterValues) => void;
  /** 默认 true；「我的成交」页传 false（负责人已固定为当前用户） */
  showOwner?: boolean;
}

export function DealFilterBar({ value, onChange, showOwner = true }: DealFilterBarProps) {
  const set = (patch: Partial<DealFilterValues>) => onChange({ ...value, ...patch });
  const single = (ids: number[]) => ids[0] ?? null;

  return (
    <>
      <span className="filter-group">
        <label>客户</label>
        <EntityPicker
          loader={customerOptionsLoader}
          cache={customerLabelCache}
          selectedIds={value.customerId === null ? [] : [value.customerId]}
          onChange={(ids) => set({ customerId: single(ids) })}
          multiple={false}
          placeholder="搜索客户…"
          ariaLabel="客户筛选"
        />
      </span>
      {showOwner && (
        <span className="filter-group">
          <label>负责人</label>
          <EntityPicker
            loader={userOptionsLoader}
            cache={userLabelCache}
            selectedIds={value.ownerId === null ? [] : [value.ownerId]}
            onChange={(ids) => set({ ownerId: single(ids) })}
            multiple={false}
            placeholder="搜索负责人…"
            ariaLabel="负责人筛选"
          />
        </span>
      )}
      <span className="filter-group">
        <label>客户归属人</label>
        <EntityPicker
          loader={userOptionsLoader}
          cache={userLabelCache}
          selectedIds={value.customerOwnerId === null ? [] : [value.customerOwnerId]}
          onChange={(ids) => set({ customerOwnerId: single(ids) })}
          multiple={false}
          placeholder="搜索归属人…"
          ariaLabel="客户归属人筛选"
        />
      </span>
      <span className="filter-group">
        <label>成交日期</label>
        <input
          aria-label="成交日期开始"
          type="date"
          value={value.startDate}
          onChange={(e) => set({ startDate: e.target.value })}
        />
        <span>~</span>
        <input
          aria-label="成交日期结束"
          type="date"
          value={value.endDate}
          onChange={(e) => set({ endDate: e.target.value })}
        />
      </span>
      <span className="filter-group">
        <label>交付日期</label>
        <select
          aria-label="交付日期空否"
          value={value.deliveryStatus}
          onChange={(e) => set({ deliveryStatus: e.target.value })}
        >
          <option value="">全部</option>
          <option value="notEmpty">已填</option>
          <option value="empty">未填</option>
        </select>
        <input
          aria-label="交付日期开始"
          type="date"
          value={value.deliveryStartDate}
          onChange={(e) => set({ deliveryStartDate: e.target.value })}
        />
        <span>~</span>
        <input
          aria-label="交付日期结束"
          type="date"
          value={value.deliveryEndDate}
          onChange={(e) => set({ deliveryEndDate: e.target.value })}
        />
      </span>
    </>
  );
}
