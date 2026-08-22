// 新增交付项弹窗（详情页 / 圈子工作台共用）：
// 标题 + 维度单选；项目维度可填起止日期；客户维度时选择覆盖客户（默认全选）。
import { useState } from "react";

import { customerOptionsLoader } from "../columns/relation";
import { dateToEpochMs } from "../columns/common";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface ItemFormModalProps {
  title: string;
  dimensionOptions: { value: string; label: string }[];
  customers: { id: number; nickname: string }[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

export function ItemFormModal({ title, dimensionOptions, customers, busy, onClose, onSubmit }: ItemFormModalProps) {
  const showToast = useToast();
  const [dimension, setDimension] = useState("project");
  const [selected, setSelected] = useState<number[]>(customers.map((c) => c.id));
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState(customers);
  const [content, setContent] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [description, setDescription] = useState("");
  const [deliveryUrl, setDeliveryUrl] = useState("");

  const doSearch = (q: string) => {
    setSearch(q);
    void customerOptionsLoader(q).then((list) => setOptions(list.map((o) => ({ id: o.id, nickname: o.label }))));
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (!content.trim()) {
            showToast("请填写交付项标题");
            return;
          }
          void onSubmit({
            content: content.trim(),
            dimension,
            // 全选 = 省略 customerIds（服务端视为全部客户）；部分选择才显式传
            customerIds:
              dimension === "customer"
                ? selected.length === customers.length
                  ? undefined
                  : selected
                : undefined,
            // 项目维度交付项：起止日期（K44 甘特排期；客户维度不显示）
            startsAt: dimension === "project" ? dateToEpochMs(startsAt) : undefined,
            endsAt: dimension === "project" ? dateToEpochMs(endsAt) : undefined,
            description: description.trim() || null,
            deliveryUrl: deliveryUrl.trim() || null,
          });
        }}
      >
        <label className="field">
          交付项标题
          <input autoComplete="off" value={content} onChange={(e) => setContent(e.target.value)} placeholder="如：拉群 / 圈子全年交付" />
        </label>
        <label className="field">
          维度
          <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
            {dimensionOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {dimension === "project" && (
          <>
            <label className="field">
              开始日期
              <input type="date" autoComplete="off" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </label>
            <label className="field">
              结束日期
              <input type="date" autoComplete="off" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </label>
          </>
        )}
        {dimension === "customer" && (
          <div className="field field-span">
            覆盖客户（{selected.length}/{customers.length}）
            <div className="form-picker">
              <input placeholder="搜索客户…" autoComplete="off" value={search} onChange={(e) => doSearch(e.target.value)} />
              <div className="form-checks">
                {options.map((c) => (
                  <label className="inline-field" key={c.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={() =>
                        setSelected((prev) =>
                          prev.includes(c.id) ? prev.filter((v) => v !== c.id) : [...prev, c.id],
                        )
                      }
                    />
                    {c.nickname}
                  </label>
                ))}
              </div>
              {search === "" && (
                <button type="button" onClick={() => setSelected(customers.map((c) => c.id))}>
                  全选
                </button>
              )}
            </div>
          </div>
        )}
        <label className="field field-span">
          交付说明
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field field-span">
          交付物链接
          <input autoComplete="off" value={deliveryUrl} onChange={(e) => setDeliveryUrl(e.target.value)} />
        </label>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}
