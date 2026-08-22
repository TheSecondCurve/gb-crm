import { useMemo, type FormEvent } from "react";

import { Modal } from "./Modal";
import type { GridColumn } from "./DataGrid/types";

interface CreateRecordModalProps<Row> {
  title: string;
  /** 复用表格列定义：取可编的 text/textarea/select 列，按列顺序排表单（Tab 即按此顺序走） */
  columns: GridColumn<Row>[];
  /** 必填列（后端 min(1) 字段，前端先用 required 拦住） */
  requiredKeys: string[];
  busy: boolean;
  onClose: () => void;
  /** body 只含填了值的键（patchKey ?? key）；空字符串缺席 = 走服务端默认值 */
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

/** 新增弹窗：不再直接 POST 空行，先在表单里填字段；Enter 提交、Esc 取消、Tab 按序切焦点 */
export function CreateRecordModal<Row>({
  title,
  columns,
  requiredKeys,
  busy,
  onClose,
  onSubmit,
}: CreateRecordModalProps<Row>) {
  const fields = useMemo(
    () =>
      columns.filter(
        (c) =>
          c.editable === true &&
          (c.editor === "text" || c.editor === "textarea" || c.editor === "select"),
      ),
    [columns],
  );

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    for (const col of fields) {
      const name = col.patchKey ?? col.key;
      const raw = fd.get(name);
      if (raw == null) continue;
      const s = String(raw).trim();
      if (s === "") continue;
      body[name] = s;
    }
    await onSubmit(body);
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={(e) => void handleSubmit(e)}>
        {fields.map((col, i) => {
          const name = col.patchKey ?? col.key;
          const required = requiredKeys.includes(col.key);
          return (
            <label className="field" key={name}>
              {col.label}
              {col.editor === "textarea" ? (
                <textarea name={name} rows={3} required={required} autoFocus={i === 0} />
              ) : col.editor === "select" ? (
                <select name={name} defaultValue="" autoFocus={i === 0}>
                  <option value="">（默认）</option>
                  {(col.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input name={name} autoComplete="off" required={required} autoFocus={i === 0} />
              )}
            </label>
          );
        })}
        <div className="modal-actions">
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
