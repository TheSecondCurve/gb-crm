// 新增/修改交付资料弹窗（K54）：kind 下拉切换 content/url 显隐（文本类 content 必填、媒体类 url 必填），
// 交付单单选（可清空；fixedDeliveryId 时锁定不显示）+ 客户多选（.form-picker 搜索 + checkbox）。
// 修改模式提交带 updatedAt（行级 OCC）；校验失败/409 由调用方 toast。
import { useEffect, useState, type FormEvent } from "react";
import { materialKindLabels } from "@gb-crm/shared";

import type { MaterialDetailDto } from "../api/types";
import { optionsOf } from "../columns/common";
import { customerLabelCache, customerOptionsLoader, deliveryOptionsLoader } from "../columns/relation";
import type { RelationOption } from "./DataGrid/DataGrid";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

const TEXT_KINDS: readonly string[] = ["transcript", "text"];

interface MaterialFormModalProps {
  title: string;
  /** 传 DetailDto = 修改模式（预填全字段 + OCC updatedAt）；缺席 = 新建 */
  material?: MaterialDetailDto;
  /** 交付单详情页内新增/修改：关联交付锁定为该单，表单不显示交付单选择 */
  fixedDeliveryId?: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

export function MaterialFormModal({ title, material, fixedDeliveryId, busy, onClose, onSubmit }: MaterialFormModalProps) {
  const showToast = useToast();
  const editing = material != null;

  const [kind, setKind] = useState(material?.kind ?? "text");
  const [materialTitle, setMaterialTitle] = useState(material?.title ?? "");
  const [content, setContent] = useState(material?.content ?? "");
  const [url, setUrl] = useState(material?.url ?? "");
  const [deliveryId, setDeliveryId] = useState<string>(material?.deliveryId ? String(material.deliveryId) : "");
  const [selected, setSelected] = useState<number[]>(material ? material.customers.map((c) => c.id) : []);

  const [deliveryOptions, setDeliveryOptions] = useState<RelationOption[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState<RelationOption[]>([]);

  const textKind = TEXT_KINDS.includes(kind);
  const lockDelivery = fixedDeliveryId !== undefined;

  // 交付单选项（单选下拉）；编辑模式当前行交付若不在前 100 条也要能显示
  useEffect(() => {
    if (lockDelivery) return;
    void deliveryOptionsLoader("").then((opts) => {
      if (material?.delivery) {
        const current = material.delivery;
        if (!opts.some((o) => o.id === current.id)) {
          opts = [{ id: current.id, label: `${current.deliveryType?.name ?? "交付"} #${current.id}` }, ...opts];
        }
      }
      setDeliveryOptions(opts);
    });
  }, [lockDelivery, material]);

  // 客户搜索（300ms 防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      void customerOptionsLoader(customerSearch).then(setCustomerOptions);
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch]);

  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!materialTitle.trim()) {
      showToast("请填写资料标题");
      return;
    }
    if (textKind && !content.trim()) {
      showToast("文本类资料必须填写内容");
      return;
    }
    if (!textKind && !url.trim()) {
      showToast("媒体类资料必须填写链接");
      return;
    }
    void onSubmit({
      // PATCH 行级 OCC：修改模式必须带当前 updatedAt（新建模式缺席）
      ...(material ? { updatedAt: material.updatedAt } : {}),
      kind,
      title: materialTitle.trim(),
      // content/url 总是成对提交：非本类的一律 null 清空，避免 kind 切换后残留脏值
      content: textKind ? content : null,
      url: textKind ? null : url.trim(),
      deliveryId: lockDelivery ? fixedDeliveryId : deliveryId ? Number(deliveryId) : null,
      customerIds: selected,
    });
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field">
          资料类型<span className="req-star">*</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {optionsOf(materialKindLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          标题<span className="req-star">*</span>
          <input autoComplete="off" value={materialTitle} onChange={(e) => setMaterialTitle(e.target.value)} />
        </label>
        {textKind ? (
          <label className="field field-span">
            内容<span className="req-star">*</span>
            <textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
        ) : (
          <label className="field field-span">
            链接<span className="req-star">*</span>
            <input autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </label>
        )}
        {!lockDelivery && (
          <label className="field">
            关联交付单
            <select value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)}>
              <option value="">（不关联）</option>
              {deliveryOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="field field-span">
          关联客户（{selected.length} 人）
          <div className="form-picker">
            <input
              placeholder="搜索客户…"
              autoComplete="off"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
            />
            <div className="form-checks">
              {customerOptions.map((o) => (
                <label className="inline-field" key={o.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(o.id)}
                    onChange={() => {
                      toggle(o.id);
                      customerLabelCache.set(o.id, o.label);
                    }}
                  />
                  {o.label}
                </label>
              ))}
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
