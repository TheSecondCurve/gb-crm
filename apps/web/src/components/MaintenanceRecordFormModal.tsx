// 新增/修改客户维护记录弹窗（K55）：kind 下拉 + 记录日期 + 内容文本域。
// 修改模式提交带 updatedAt（行级 OCC）；校验失败/409 由调用方 toast。
import { useState, type FormEvent } from "react";
import { maintenanceKindLabels } from "@gb-crm/shared";

import type { CustomerMaintenanceRecordDto } from "../api/types";
import { dateToEpochMs, epochMsToDate, optionsOf } from "../columns/common";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface MaintenanceRecordFormModalProps {
  title: string;
  /** 传 DTO = 修改模式（预填 + OCC updatedAt）；缺席 = 新建 */
  record?: CustomerMaintenanceRecordDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

export function MaintenanceRecordFormModal({
  title,
  record,
  busy,
  onClose,
  onSubmit,
}: MaintenanceRecordFormModalProps) {
  const showToast = useToast();
  const editing = record != null;

  const [kind, setKind] = useState(record?.kind ?? "follow_up");
  const [happenedAt, setHappenedAt] = useState(record ? epochMsToDate(record.happenedAt) : epochMsToDate(Date.now()));
  const [content, setContent] = useState(record?.content ?? "");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const happenedAtMs = dateToEpochMs(happenedAt);
    if (!happenedAtMs) {
      showToast("请选择有效的记录日期");
      return;
    }
    void onSubmit({
      // PATCH 行级 OCC：修改模式必须带当前 updatedAt（新建模式缺席）
      ...(editing ? { updatedAt: record!.updatedAt } : {}),
      kind,
      happenedAt: happenedAtMs,
      content: content.trim() === "" ? null : content.trim(),
    });
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field">
          类型<span className="req-star">*</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {optionsOf(maintenanceKindLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          记录日期<span className="req-star">*</span>
          <input type="date" autoComplete="off" value={happenedAt} onChange={(e) => setHappenedAt(e.target.value)} />
        </label>
        <label className="field field-span">
          内容
          <textarea
            rows={6}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="这次跟进说了什么 / 客户状态 / 新线索…"
          />
        </label>
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
