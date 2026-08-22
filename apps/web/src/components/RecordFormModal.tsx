import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Modal } from "./Modal";
import type { GridColumn, GridRow, RelationOption } from "./DataGrid/types";

const FORM_EDITORS = new Set(["text", "textarea", "select", "multi", "relation", "relation-one"]);

interface RecordFormModalProps<Row extends GridRow> {
  title: string;
  /** 复用表格列定义：取可编列，按列顺序排表单（Tab 即按此顺序走） */
  columns: GridColumn<Row>[];
  /** 必填列（后端 min(1) 字段，前端先用 required 拦住） */
  requiredKeys: string[];
  busy: boolean;
  /** 传行 = 修改模式：预填全字段、只提交变更键并带 OCC updatedAt；缺席 = 新增 */
  row?: Row;
  onClose: () => void;
  /**
   * 新增：body 只含填了值的键（patchKey ?? key），空值缺席 = 走服务端默认值。
   * 修改：body 只含变更键 + updatedAt；标量清空提交 null，关系数组 [] = 清空。
   */
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function asNumArr(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

function asNumOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function initialOf<Row extends GridRow>(col: GridColumn<Row>, row: Row | undefined): unknown {
  if (!row) {
    if (col.editor === "multi" || col.editor === "relation") return [];
    if (col.editor === "relation-one") return null;
    return "";
  }
  const raw = col.getValue ? col.getValue(row) : (row as Record<string, unknown>)[col.key];
  if (col.editor === "multi") return asStrArr(raw);
  if (col.editor === "relation") return asNumArr(raw);
  if (col.editor === "relation-one") return asNumOrNull(raw);
  return asStr(raw);
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** 新增/修改全字段表单弹窗：多列布局；Enter 提交、Esc 取消、Tab 按序切焦点 */
export function RecordFormModal<Row extends GridRow>({
  title,
  columns,
  requiredKeys,
  busy,
  row,
  onClose,
  onSubmit,
}: RecordFormModalProps<Row>) {
  const editing = row != null;
  const fields = useMemo(
    () => columns.filter((c) => c.editable === true && c.editor != null && FORM_EDITORS.has(c.editor)),
    [columns],
  );

  const [initial] = useState(() => {
    const init: Record<string, unknown> = {};
    for (const col of fields) init[col.patchKey ?? col.key] = initialOf(col, row);
    return init;
  });
  const [values, setValues] = useState<Record<string, unknown>>(initial);

  const setValue = (name: string, v: unknown) => setValues((prev) => ({ ...prev, [name]: v }));

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const col of fields) {
      const name = col.patchKey ?? col.key;
      const v = values[name];
      if (!editing) {
        if (isEmpty(v)) continue;
        body[name] = typeof v === "string" ? v.trim() : v;
      } else {
        if (sameValue(v, initial[name])) continue;
        body[name] = typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v;
      }
    }
    if (editing) body.updatedAt = row.updatedAt;
    await onSubmit(body);
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        {fields.map((col, i) => {
          const name = col.patchKey ?? col.key;
          const required = requiredKeys.includes(col.key);
          const span = col.editor !== "text" && col.editor !== "select";
          const className = span ? "field field-span" : "field";
          const value = values[name];

          if (col.editor === "multi") {
            const selected = asStrArr(value);
            return (
              <div className={className} key={name}>
                {col.label}
                <div className="form-checks">
                  {(col.options ?? []).map((o) => (
                    <label className="inline-field" key={o.value}>
                      <input
                        type="checkbox"
                        checked={selected.includes(o.value)}
                        onChange={() =>
                          setValue(
                            name,
                            selected.includes(o.value)
                              ? selected.filter((v) => v !== o.value)
                              : [...selected, o.value],
                          )
                        }
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              </div>
            );
          }

          if (col.editor === "relation" || col.editor === "relation-one") {
            return (
              <div className={className} key={name}>
                {col.label}
                <RelationPicker
                  single={col.editor === "relation-one"}
                  loader={col.relationLoader}
                  selectedIds={col.editor === "relation" ? asNumArr(value) : []}
                  selected={col.editor === "relation-one" ? asNumOrNull(value) : null}
                  onChange={(v) => setValue(name, v)}
                />
              </div>
            );
          }

          return (
            <label className={className} key={name}>
              {col.label}
              {col.editor === "textarea" ? (
                <textarea
                  rows={3}
                  required={required}
                  autoFocus={i === 0}
                  value={asStr(value)}
                  onChange={(e) => setValue(name, e.target.value)}
                />
              ) : col.editor === "select" ? (
                <select
                  value={asStr(value)}
                  autoFocus={i === 0}
                  onChange={(e) => setValue(name, e.target.value)}
                >
                  <option value="">{editing ? "（清空）" : "（默认）"}</option>
                  {(col.options ?? []).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  autoComplete="off"
                  required={required}
                  autoFocus={i === 0}
                  value={asStr(value)}
                  onChange={(e) => setValue(name, e.target.value)}
                />
              )}
            </label>
          );
        })}
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

interface RelationPickerProps {
  single: boolean;
  loader?: (search: string) => Promise<RelationOption[]>;
  /** 多选当前值 */
  selectedIds: number[];
  /** 单选当前值 */
  selected: number | null;
  onChange: (value: number[] | number | null) => void;
}

/** 表单内可搜索关系选择（复用 cell 编辑器的 loader 约定；多选 checkbox / 单选按钮 + 清除） */
function RelationPicker({ single, loader, selectedIds, selected, onChange }: RelationPickerProps) {
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<RelationOption[]>([]);

  useEffect(() => {
    let live = true;
    void loader?.(search).then((list) => {
      if (live) setOptions(list);
    });
    return () => {
      live = false;
    };
  }, [loader, search]);

  return (
    <div className="form-picker">
      <input
        placeholder="搜索…"
        autoComplete="off"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="form-checks">
        {single ? (
          <>
            {options.map((o) => (
              <label className="inline-field" key={o.id}>
                <input
                  type="radio"
                  checked={o.id === selected}
                  onChange={() => onChange(o.id)}
                />
                {o.label}
              </label>
            ))}
            {selected !== null && (
              <button type="button" className="cell-relation-option" onClick={() => onChange(null)}>
                清除
              </button>
            )}
          </>
        ) : (
          options.map((o) => (
            <label className="inline-field" key={o.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(o.id)}
                onChange={() =>
                  onChange(
                    selectedIds.includes(o.id)
                      ? selectedIds.filter((v) => v !== o.id)
                      : [...selectedIds, o.id],
                  )
                }
              />
              {o.label}
            </label>
          ))
        )}
      </div>
    </div>
  );
}
