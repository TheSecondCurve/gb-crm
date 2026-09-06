// 成交分成动态筛选器：扁平条件列表 + 全局 AND/OR（不做嵌套分组）。
// 条件字段：成交日期（范围）/ 交付日期（范围/已填/未填）/ 产品（多选，命中任一）。
// 纯受控展示组件：不发请求，value 变化即向上抛；serializeCommissionFilters 负责
// 把 UI 态序列化为 GET /deals/commissions 的 filters query（JSON 字符串），
// 不完整规则（日期两端都空 / 产品未选）跳过，剩余 0 条 → 不带 filters。
import { Plus, Trash } from "@phosphor-icons/react";
import type { CommissionFilterGroup, CommissionFilterRule } from "@gb-crm/shared";

import { dateToEpochMs } from "../columns/common";
import { productLabelCache, productOptionsLoader } from "../columns/relation";
import { EntityPicker } from "./EntityPicker";

const DAY_TAIL_MS = 86399999; // 当日 23:59:59.999（end 含当天）

export type FilterField = "dealDate" | "deliveryDate" | "productId";
export type FilterOp = "between" | "empty" | "notEmpty";

export interface FilterRuleState {
  key: string;
  field: FilterField;
  /** 日期类条件操作符；productId 恒为 between 占位（不参与序列化） */
  op: FilterOp;
  /** YYYY-MM-DD 输入框原始值 */
  start: string;
  end: string;
  productIds: number[];
}

export interface CommissionFilterBuilderValue {
  combinator: "and" | "or";
  rules: FilterRuleState[];
}

let keySeq = 0;
const nextKey = () => `rule-${++keySeq}`;

function emptyRule(field: FilterField = "dealDate"): FilterRuleState {
  return { key: nextKey(), field, op: "between", start: "", end: "", productIds: [] };
}

/** 页面初始值：保持原有默认行为——交付日期「已填」 */
export function defaultCommissionFilters(): CommissionFilterBuilderValue {
  return { combinator: "and", rules: [{ ...emptyRule("deliveryDate"), op: "notEmpty" }] };
}

const FIELD_OPTIONS: { value: FilterField; label: string }[] = [
  { value: "dealDate", label: "成交日期" },
  { value: "deliveryDate", label: "交付日期" },
  { value: "productId", label: "产品" },
];

/** 单条 UI 规则 → API 规则；不完整 → null（跳过） */
function serializeRule(rule: FilterRuleState): CommissionFilterRule | null {
  if (rule.field === "productId") {
    return rule.productIds.length === 0
      ? null
      : { field: "productId", op: "in", ids: [...rule.productIds] };
  }
  if (rule.op === "empty" || rule.op === "notEmpty") {
    // 空否仅交付日期支持（dealDate 恒为 between，UI 不渲染该选项）
    return rule.field === "deliveryDate" ? { field: "deliveryDate", op: rule.op } : null;
  }
  const from = dateToEpochMs(rule.start);
  const end = dateToEpochMs(rule.end);
  if (from === null && end === null) return null;
  const range = {
    ...(from === null ? {} : { from }),
    ...(end === null ? {} : { to: end + DAY_TAIL_MS }),
  };
  return rule.field === "dealDate"
    ? { field: "dealDate", op: "between", ...range }
    : { field: "deliveryDate", op: "between", ...range };
}

/** UI 态 → filters query 字符串；无有效规则 → undefined */
export function serializeCommissionFilters(
  value: CommissionFilterBuilderValue,
): string | undefined {
  const rules = value.rules
    .map(serializeRule)
    .filter((r): r is CommissionFilterRule => r !== null);
  if (rules.length === 0) return undefined;
  const group: CommissionFilterGroup = { combinator: value.combinator, rules };
  return JSON.stringify(group);
}

interface CommissionFilterBuilderProps {
  value: CommissionFilterBuilderValue;
  onChange: (next: CommissionFilterBuilderValue) => void;
}

export function CommissionFilterBuilder({ value, onChange }: CommissionFilterBuilderProps) {
  const setRule = (key: string, patch: Partial<FilterRuleState>) =>
    onChange({
      ...value,
      rules: value.rules.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    });

  const changeField = (key: string, field: FilterField) =>
    onChange({
      ...value,
      rules: value.rules.map((r) => (r.key === key ? { ...emptyRule(field), key } : r)),
    });

  const removeRule = (key: string) =>
    onChange({ ...value, rules: value.rules.filter((r) => r.key !== key) });

  const addRule = () => onChange({ ...value, rules: [...value.rules, emptyRule()] });

  return (
    <div className="filter-builder">
      <span className="filter-group">
        <select
          aria-label="条件组合"
          value={value.combinator}
          onChange={(e) =>
            onChange({ ...value, combinator: e.target.value as "and" | "or" })
          }
        >
          <option value="and">满足全部(AND)</option>
          <option value="or">满足任一(OR)</option>
        </select>
        <button type="button" onClick={addRule}>
          <Plus weight="bold" aria-hidden /> 添加条件
        </button>
      </span>
      {value.rules.map((rule) => (
        <span className="filter-group" key={rule.key}>
          <select
            aria-label="条件字段"
            value={rule.field}
            onChange={(e) => changeField(rule.key, e.target.value as FilterField)}
          >
            {FIELD_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          {rule.field === "productId" ? (
            <EntityPicker
              loader={productOptionsLoader}
              cache={productLabelCache}
              selectedIds={rule.productIds}
              onChange={(ids) => setRule(rule.key, { productIds: ids })}
              placeholder="搜索产品…"
              ariaLabel="产品筛选"
            />
          ) : (
            <>
              {rule.field === "deliveryDate" && (
                <select
                  aria-label="交付日期条件"
                  value={rule.op}
                  onChange={(e) => setRule(rule.key, { op: e.target.value as FilterOp })}
                >
                  <option value="between">日期范围</option>
                  <option value="notEmpty">已填</option>
                  <option value="empty">未填</option>
                </select>
              )}
              {rule.op === "between" && (
                <>
                  <input
                    aria-label="开始日期"
                    type="date"
                    value={rule.start}
                    onChange={(e) => setRule(rule.key, { start: e.target.value })}
                  />
                  <span>~</span>
                  <input
                    aria-label="结束日期"
                    type="date"
                    value={rule.end}
                    onChange={(e) => setRule(rule.key, { end: e.target.value })}
                  />
                </>
              )}
            </>
          )}
          <button
            type="button"
            aria-label="删除条件"
            onClick={() => removeRule(rule.key)}
          >
            <Trash weight="bold" aria-hidden />
          </button>
        </span>
      ))}
    </div>
  );
}
