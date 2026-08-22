import { useEffect, useState, type FormEvent } from "react";

import { api, ApiError, buildQuery } from "../api/client";
import type { DeliveryDto, DeliveryTypeDto } from "../api/types";
import { dateToEpochMs, epochMsToDate } from "../columns/common";
import { customerLabelCache, customerOptionsLoader, productLabelCache, productOptionsLoader } from "../columns/relation";
import type { RelationOption } from "./DataGrid/DataGrid";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface DeliveryFormModalProps {
  title: string;
  /** 传行 = 修改模式（预填类型/客户/备注）；缺席 = 新建 */
  delivery?: DeliveryDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

/**
 * 交付单弹窗：类型（下拉）+ 起止日期（日历输入）+ 客户集合（两种来源合并：手动搜索多选 /
 * 按意向产品从成交 merge）+ 备注。客户可不选（空交付单）。
 */
export function DeliveryFormModal({ title, delivery, busy, onClose, onSubmit }: DeliveryFormModalProps) {
  const showToast = useToast();
  const editing = delivery != null;

  const [typeOptions, setTypeOptions] = useState<RelationOption[]>([]);
  const [typeId, setTypeId] = useState<string>(delivery ? String(delivery.deliveryTypeId) : "");
  const [startsAt, setStartsAt] = useState(delivery ? epochMsToDate(delivery.startsAt) : "");
  const [endsAt, setEndsAt] = useState(delivery ? epochMsToDate(delivery.endsAt) : "");
  const [selected, setSelected] = useState<number[]>(delivery ? delivery.customers.map((c) => c.id) : []);
  const [remark, setRemark] = useState(delivery?.remark ?? "");

  // 手动搜索客户
  const [manualSearch, setManualSearch] = useState("");
  const [manualOptions, setManualOptions] = useState<RelationOption[]>([]);
  // 按意向产品 merge（来自成交的客户）
  const [mergeProductSearch, setMergeProductSearch] = useState("");
  const [mergeProductOptions, setMergeProductOptions] = useState<RelationOption[]>([]);
  const [mergeProduct, setMergeProduct] = useState<RelationOption | null>(null);
  const [mergeCandidates, setMergeCandidates] = useState<RelationOption[]>([]);
  const [mergeLoading, setMergeLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ data: DeliveryTypeDto[] }>(
        `/delivery-types${buildQuery({ pageSize: 100 })}`,
      );
      setTypeOptions((res?.data ?? []).map((t) => ({ id: t.id, label: t.name })));
    })();
  }, []);

  // 手动搜索（300ms 防抖由 loader 层承担，这里直接 debounce）
  useEffect(() => {
    const timer = setTimeout(() => {
      void customerOptionsLoader(manualSearch).then(setManualOptions);
    }, 300);
    return () => clearTimeout(timer);
  }, [manualSearch]);

  // 按意向产品加载成交客户（去重）
  useEffect(() => {
    if (!mergeProduct) {
      setMergeCandidates([]);
      return;
    }
    setMergeLoading(true);
    void (async () => {
      try {
        const res = await api.get<{ data: { customer: { id: number; nickname: string } | null }[] }>(
          `/deals${buildQuery({ pageSize: 100, productId: mergeProduct.id })}`,
        );
        const seen = new Map<number, RelationOption>();
        for (const d of res?.data ?? []) {
          if (d.customer) seen.set(d.customer.id, { id: d.customer.id, label: d.customer.nickname });
        }
        setMergeCandidates([...seen.values()]);
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "加载成交客户失败");
      } finally {
        setMergeLoading(false);
      }
    })();
  }, [mergeProduct, showToast]);

  // 意向产品搜索（300ms 防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      void productOptionsLoader(mergeProductSearch).then(setMergeProductOptions);
    }, 300);
    return () => clearTimeout(timer);
  }, [mergeProductSearch]);

  const toggle = (list: number[], id: number): number[] =>
    list.includes(id) ? list.filter((v) => v !== id) : [...list, id];

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!typeId) {
      showToast("请选择交付类型");
      return;
    }
    void onSubmit({
      deliveryTypeId: Number(typeId),
      customerIds: selected,
      startsAt: dateToEpochMs(startsAt),
      endsAt: dateToEpochMs(endsAt),
      remark: remark.trim() || null,
    });
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field">
          交付类型
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            <option value="">（请选择）</option>
            {typeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          交付备注
          <input autoComplete="off" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </label>
        <label className="field">
          开始日期
          <input
            type="date"
            autoComplete="off"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </label>
        <label className="field">
          结束日期
          <input
            type="date"
            autoComplete="off"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </label>

        <div className="field field-span">
          关联客户（{selected.length} 人）
          <div className="form-picker">
            <div className="delivery-picker-block">
              <div className="delivery-picker-title">① 手动搜索选择</div>
              <input
                placeholder="搜索客户…"
                autoComplete="off"
                value={manualSearch}
                onChange={(e) => setManualSearch(e.target.value)}
              />
              <div className="form-checks">
                {manualOptions.map((o) => (
                  <label className="inline-field" key={o.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(o.id)}
                      onChange={() => {
                        setSelected((prev) => toggle(prev, o.id));
                        customerLabelCache.set(o.id, o.label);
                      }}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="delivery-picker-block">
              <div className="delivery-picker-title">② 按意向产品从成交合并</div>
              <input
                placeholder="搜索意向产品…"
                autoComplete="off"
                value={mergeProductSearch}
                onChange={(e) => setMergeProductSearch(e.target.value)}
              />
              {!mergeProduct && mergeProductOptions.length > 0 && (
                <div className="form-checks">
                  {mergeProductOptions.map((o) => (
                    <label className="inline-field" key={o.id}>
                      <input
                        type="radio"
                        name="merge-product"
                        onChange={() => {
                          setMergeProduct(o);
                          productLabelCache.set(o.id, o.label);
                        }}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              {mergeProduct && (
                <div className="delivery-picker-selected">
                  已选产品：<b>{mergeProduct.label}</b>
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => {
                      setMergeProduct(null);
                      setMergeProductSearch("");
                    }}
                  >
                    更换
                  </button>
                </div>
              )}
              {mergeLoading && <div className="task-empty">加载中…</div>}
              {!mergeLoading && mergeProduct && mergeCandidates.length > 0 && (
                <div className="form-checks">
                  {mergeCandidates.map((o) => (
                    <label className="inline-field" key={o.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(o.id)}
                        onChange={() => {
                          setSelected((prev) => toggle(prev, o.id));
                          customerLabelCache.set(o.id, o.label);
                        }}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              {!mergeLoading && mergeProduct && mergeCandidates.length === 0 && (
                <div className="task-empty">该产品暂无成交客户</div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {editing ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
