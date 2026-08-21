import { useState } from "react";

export interface ColumnPickerItem {
  key: string;
  label: string;
  /** 冻结列等不可隐藏 */
  locked?: boolean;
}

interface ColumnPickerProps {
  columns: ColumnPickerItem[];
  visibleKeys: string[];
  onChange: (visibleKeys: string[]) => void;
}

/** 列选择器：勾选控制列显隐（持久化由调用方做，DataGrid 按 gridId 写 localStorage） */
export function ColumnPicker({ columns, visibleKeys, onChange }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);

  const toggle = (key: string) => {
    const next = visibleKeys.includes(key)
      ? visibleKeys.filter((k) => k !== key)
      : [...visibleKeys, key];
    onChange(next);
  };

  return (
    <div className="column-picker">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        列设置
      </button>
      {open && (
        <div className="column-picker-panel" role="group" aria-label="列设置">
          {columns.map((col) => (
            <label key={col.key} className="inline-field">
              <input
                type="checkbox"
                checked={visibleKeys.includes(col.key)}
                disabled={col.locked}
                onChange={() => toggle(col.key)}
              />
              {col.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
