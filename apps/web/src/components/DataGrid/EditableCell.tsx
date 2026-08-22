import { useEffect, useState } from "react";

import type { GridColumn, RelationOption } from "./types";

interface EditableCellProps<Row> {
  row: Row;
  column: GridColumn<Row>;
  /** text / textarea：草稿变化（父层 300ms debounce 后入队） */
  onDraft: (value: unknown) => void;
  /** Enter / Tab / Shift+Tab：父层先 flush debounce 并入队，再移动 */
  onCommitKey: (dir: "down" | "right" | "left") => void;
  /** select / multi / relation：变更立即入队 */
  onCommitNow: (value: unknown) => void;
  /** 退出编辑（选择器选完） */
  onExit: () => void;
  /** Esc：取消，不入队（仅对未入队的文本草稿有意义） */
  onCancel: () => void;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function readStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function readNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

/** 单元格编辑器。键盘：Enter 提交并下移；Tab 右移；Shift+Tab 左移；Esc 取消。 */
export function EditableCell<Row>({
  row,
  column,
  onDraft,
  onCommitKey,
  onCommitNow,
  onExit,
  onCancel,
}: EditableCellProps<Row>) {
  const editor = column.editor;
  const initial = column.getValue ? column.getValue(row) : (row as Record<string, unknown>)[column.key];
  const [draft, setDraft] = useState<string>(() => readString(initial));

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !(editor === "textarea" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      onCommitKey("down");
    } else if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onCommitKey(e.shiftKey ? "left" : "right");
    }
  };

  if (editor === "text") {
    return (
      <input
        autoFocus
        aria-label={column.label}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onDraft(e.target.value);
        }}
        onKeyDown={handleKey}
      />
    );
  }

  if (editor === "textarea") {
    return (
      <textarea
        autoFocus
        rows={3}
        aria-label={column.label}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onDraft(e.target.value);
        }}
        onKeyDown={handleKey}
      />
    );
  }

  if (editor === "select") {
    return (
      <select
        autoFocus
        aria-label={column.label}
        value={readString(initial)}
        onChange={(e) => {
          onCommitNow(e.target.value);
          onExit();
        }}
        onKeyDown={handleKey}
      >
        {(column.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (editor === "date") {
    return (
      <input
        autoFocus
        type="date"
        aria-label={column.label}
        value={draft}
        onChange={(e) => {
          // 日历选择即提交（YYYY-MM-DD，patchRow 层转 epoch ms）
          onCommitNow(e.target.value);
          onExit();
        }}
        onKeyDown={handleKey}
      />
    );
  }

  if (editor === "multi") {
    const values = readStringArray(initial);
    const toggle = (value: string) => {
      const next = values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value];
      onCommitNow(next);
    };
    return (
      <div className="cell-dropdown" role="group" aria-label={column.label} onKeyDown={handleKey}>
        {(column.options ?? []).map((o, i) => (
          <label key={o.value} className="inline-field">
            <input
              type="checkbox"
              autoFocus={i === 0}
              checked={values.includes(o.value)}
              onChange={() => toggle(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  }

  if (editor === "relation" || editor === "relation-one") {
    return (
      <RelationEditor
        single={editor === "relation-one"}
        label={column.label}
        loader={column.relationLoader}
        selected={editor === "relation-one" ? (typeof initial === "number" ? initial : null) : null}
        selectedIds={editor === "relation" ? readNumberArray(initial) : []}
        onCommitNow={onCommitNow}
        onExit={onExit}
        onKeyDown={handleKey}
      />
    );
  }

  return null;
}

interface RelationEditorProps {
  single: boolean;
  label: string;
  loader?: (search: string) => Promise<RelationOption[]>;
  selected: number | null;
  selectedIds: number[];
  onCommitNow: (value: unknown) => void;
  onExit: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/** 可搜索关系选择：选项由调用方注入 loader（relation 多选 / relation-one 单选），变更立即入队 */
function RelationEditor({
  single,
  label,
  loader,
  selected,
  selectedIds,
  onCommitNow,
  onExit,
  onKeyDown,
}: RelationEditorProps) {
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

  const toggle = (id: number) => {
    const next = selectedIds.includes(id)
      ? selectedIds.filter((v) => v !== id)
      : [...selectedIds, id];
    onCommitNow(next);
  };

  return (
    <div className="cell-dropdown" role="group" aria-label={label} onKeyDown={onKeyDown}>
      <input
        autoFocus
        className="cell-relation-search"
        placeholder="搜索…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {single ? (
        <>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={o.id === selected ? "cell-relation-option active" : "cell-relation-option"}
              onClick={() => {
                onCommitNow(o.id);
                onExit();
              }}
            >
              {o.label}
            </button>
          ))}
          <button
            type="button"
            className="cell-relation-option"
            onClick={() => {
              onCommitNow(null);
              onExit();
            }}
          >
            清除
          </button>
        </>
      ) : (
        options.map((o) => (
          <label key={o.id} className="inline-field">
            <input
              type="checkbox"
              checked={selectedIds.includes(o.id)}
              onChange={() => toggle(o.id)}
            />
            {o.label}
          </label>
        ))
      )}
    </div>
  );
}
