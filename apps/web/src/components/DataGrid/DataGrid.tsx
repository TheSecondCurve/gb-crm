import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { useToast } from "../Toast";
import { ColumnPicker } from "./ColumnPicker";
import { EditableCell } from "./EditableCell";
import {
  createRowPatchQueue,
  type RowPatchQueue,
} from "./rowPatchQueue";
import type { GridColumn, GridRow } from "./types";

const TEXT_DEBOUNCE_MS = 300;

export interface DataGridProps<Row extends GridRow> {
  /** 列显隐 localStorage 命名空间 */
  gridId: string;
  columns: GridColumn<Row>[];
  rows: Row[];
  loading?: boolean;
  /** react-query 列表 query key（前缀匹配各页）；乐观更新 / 200 合并 / 409 替换都写它 */
  queryKey: readonly unknown[];
  /** 真正发 PATCH；409 时 reject 带 status/data 的错误（ApiError 即满足） */
  patchRow: (id: number, body: Record<string, unknown>) => Promise<Row>;
  isRowDisabled?: (row: Row) => boolean;
  /** 行尾操作列（删除按钮等） */
  renderRowActions?: (row: Row) => ReactNode;
  emptyText?: string;
  ref?: Ref<DataGridHandle>;
}

export interface DataGridHandle {
  /** 取消文本 debounce 并入队 + await 所有行队列排空（翻页 / 卸载前用） */
  flushAll: () => Promise<void>;
}

interface CellPos {
  rowId: number;
  colKey: string;
}

type ListLike<Row> = { data: Row[]; meta?: unknown };

/** 前缀匹配 queryKey 的所有列表缓存，按 id 就地更新一行 */
function mapRowInQueries<Row extends GridRow>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  id: number,
  fn: (row: Row) => Row,
): void {
  queryClient.setQueriesData({ queryKey: [...queryKey] }, (old: ListLike<Row> | undefined) => {
    if (!old || !Array.isArray(old.data)) return old;
    return { ...old, data: old.data.map((r) => (r.id === id ? fn(r) : r)) };
  });
}

/** localStorage 列显隐 key 规范（DataGrid 与自定义表格共用，如圈子工作台客户表） */
export function storageKeyOf(gridId: string): string {
  return `gb-crm:datagrid:${gridId}:columns`;
}

function displayValue<Row>(row: Row, col: GridColumn<Row>): ReactNode {
  if (col.render) return col.render(row);
  const v = col.getValue ? col.getValue(row) : (row as Record<string, unknown>)[col.key];
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.join("、");
  return String(v);
}

/**
 * Excel 式表格内核（design.md §7）：
 * 单击选中、双击/Enter 编辑；Enter 下移、Tab 右移、Shift+Tab 左移、Esc 取消；
 * 文本 300ms debounce 入队，select/multi/relation 立即入队；每行串行 PATCH 队列见 rowPatchQueue.ts。
 */
export function DataGrid<Row extends GridRow>({
  gridId,
  columns,
  rows,
  loading,
  queryKey,
  patchRow,
  isRowDisabled,
  renderRowActions,
  emptyText = "暂无数据",
  ref,
}: DataGridProps<Row>) {
  const queryClient = useQueryClient();
  const showToast = useToast();

  const [visibleKeys, setVisibleKeys] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(storageKeyOf(gridId));
      if (raw) {
        const keys = (JSON.parse(raw) as unknown[]).filter(
          (k): k is string => typeof k === "string" && columns.some((c) => c.key === k),
        );
        if (keys.length > 0) return keys;
      }
    } catch {
      /* localStorage 不可用时用默认 */
    }
    return columns.map((c) => c.key);
  });

  const [selected, setSelected] = useState<CellPos | null>(null);
  const [editing, setEditing] = useState<CellPos | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  /** 每行一条 PATCH 队列（design.md §7.6） */
  const queuesRef = useRef<Map<number, RowPatchQueue>>(new Map());
  /** 文本编辑的 debounce：一格一份 */
  const debounceRef = useRef<{
    timer: ReturnType<typeof setTimeout>;
    row: Row;
    col: GridColumn<Row>;
    value: unknown;
  } | null>(null);

  // 最新回调挂 ref，供 unmount cleanup 使用
  const patchRowRef = useRef(patchRow);
  patchRowRef.current = patchRow;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const getQueue = useCallback((row: Row): RowPatchQueue => {
    let q = queuesRef.current.get(row.id);
    if (!q) {
      const id = row.id;
      q = createRowPatchQueue<Row>({
        updatedAt: row.updatedAt,
        patchFn: (body) => patchRowRef.current(id, body),
        onRow: (fresh) => {
          mapRowInQueries(queryClient, queryKeyRef.current, id, () => fresh);
        },
        onConflict: () => showToastRef.current("该行已被他人更新"),
        onError: (err) =>
          showToastRef.current(err instanceof Error ? err.message : "保存失败，请稍后重试"),
      });
      queuesRef.current.set(id, q);
    }
    return q;
  }, [queryClient]);

  // GET refetch 等外部更新对齐队列版本号（仅空闲时生效）
  useEffect(() => {
    for (const row of rows) queuesRef.current.get(row.id)?.syncUpdatedAt(row.updatedAt);
  }, [rows]);

  const commitValue = useCallback(
    (row: Row, col: GridColumn<Row>, value: unknown) => {
      // 乐观更新 cache（§7.5）
      mapRowInQueries<Row>(queryClient, queryKeyRef.current, row.id, (r) =>
        col.applyOptimistic ? col.applyOptimistic(r, value) : ({ ...r, [col.key]: value } as Row),
      );
      getQueue(row).enqueue({ [col.patchKey ?? col.key]: value });
    },
    [queryClient, getQueue],
  );

  /** Tab/Enter/翻页/卸载前必须调用：取消 debounce 并立即入队（§7.4） */
  const flushDebounce = useCallback(() => {
    const d = debounceRef.current;
    if (!d) return;
    clearTimeout(d.timer);
    debounceRef.current = null;
    commitValue(d.row, d.col, d.value);
  }, [commitValue]);

  const cancelDebounce = useCallback(() => {
    const d = debounceRef.current;
    if (!d) return;
    clearTimeout(d.timer);
    debounceRef.current = null;
  }, []);

  const scheduleTextCommit = useCallback(
    (row: Row, col: GridColumn<Row>, value: unknown) => {
      cancelDebounce();
      debounceRef.current = {
        row,
        col,
        value,
        timer: setTimeout(() => {
          debounceRef.current = null;
          commitValue(row, col, value);
        }, TEXT_DEBOUNCE_MS),
      };
    },
    [cancelDebounce, commitValue],
  );

  const visibleCols = columns.filter((c) => visibleKeys.includes(c.key));
  const isEditableCol = (col: GridColumn<Row>) => col.editable === true && col.editor != null;

  const move = (dir: "down" | "right" | "left") => {
    const cur = editing;
    if (!cur) return;
    const colIdx = visibleCols.findIndex((c) => c.key === cur.colKey);
    const rowIdx = rows.findIndex((r) => r.id === cur.rowId);
    let target: CellPos | null = null;
    if (dir === "down" && rowIdx >= 0 && rowIdx < rows.length - 1) {
      target = { rowId: rows[rowIdx + 1]!.id, colKey: cur.colKey };
    } else if (dir === "right" && colIdx >= 0 && colIdx < visibleCols.length - 1) {
      target = { rowId: cur.rowId, colKey: visibleCols[colIdx + 1]!.key };
    } else if (dir === "left" && colIdx > 0) {
      target = { rowId: cur.rowId, colKey: visibleCols[colIdx - 1]!.key };
    }
    setEditing(null);
    if (target) {
      setSelected(target);
      const col = visibleCols.find((c) => c.key === target!.colKey);
      // 横向移动直接进入下一格编辑（Excel 式连改）；下移只选中
      if (dir !== "down" && col && isEditableCol(col)) setEditing(target);
    }
  };

  // 非编辑态下让选中格拿到焦点（Enter 进入编辑、焦点断言都依赖它）
  useEffect(() => {
    if (selected && !editing) {
      containerRef.current
        ?.querySelector<HTMLElement>(`[data-cell="${selected.rowId}:${selected.colKey}"]`)
        ?.focus();
    }
  }, [selected, editing]);

  const flushAll = useCallback(async () => {
    flushDebounce();
    await Promise.all([...queuesRef.current.values()].map((q) => q.flush()));
  }, [flushDebounce]);

  useImperativeHandle(ref, () => ({ flushAll }), [flushAll]);

  // 路由卸载：立即 flush debounce 并入队（§7.6）。PATCH 同步发出，排空由队列自己完成
  const flushAllRef = useRef(flushAll);
  flushAllRef.current = flushAll;
  useEffect(() => {
    return () => {
      void flushAllRef.current();
    };
  }, []);

  const handleCellClick = (row: Row, col: GridColumn<Row>) => {
    if (editing && (editing.rowId !== row.id || editing.colKey !== col.key)) {
      flushDebounce();
      setEditing(null);
    }
    setSelected({ rowId: row.id, colKey: col.key });
  };

  const handleCellDoubleClick = (row: Row, col: GridColumn<Row>) => {
    if (!isEditableCol(col)) return;
    flushDebounce();
    setSelected({ rowId: row.id, colKey: col.key });
    setEditing({ rowId: row.id, colKey: col.key });
  };

  const handleCellKeyDown = (e: React.KeyboardEvent, row: Row, col: GridColumn<Row>) => {
    if (e.key === "Enter" && isEditableCol(col)) {
      e.preventDefault();
      setSelected({ rowId: row.id, colKey: col.key });
      setEditing({ rowId: row.id, colKey: col.key });
    }
  };

  const pickerColumns = columns.map((c, i) => ({ key: c.key, label: c.label, locked: i === 0 }));
  const handleVisibleChange = (keys: string[]) => {
    const first = columns[0];
    const next = first && !keys.includes(first.key) ? [first.key, ...keys] : keys;
    setVisibleKeys(next);
    try {
      localStorage.setItem(storageKeyOf(gridId), JSON.stringify(next));
    } catch {
      /* 忽略持久化失败 */
    }
  };

  const toolbar = (
    <div className="grid-toolbar">
      <ColumnPicker columns={pickerColumns} visibleKeys={visibleKeys} onChange={handleVisibleChange} />
    </div>
  );

  if (loading) {
    return (
      <div className="data-grid" ref={containerRef}>
        {toolbar}
        <div className="empty">加载中…</div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="data-grid" ref={containerRef}>
        {toolbar}
        <div className="empty">{emptyText}</div>
      </div>
    );
  }

  return (
    <div className="data-grid" ref={containerRef}>
      {toolbar}
      <div className="data-grid-scroll">
        <table className="data-table data-grid-table">
          <thead>
            <tr>
              {visibleCols.map((col) => (
                <th key={col.key} style={col.width ? { width: col.width, minWidth: col.width } : undefined}>
                  {col.label}
                </th>
              ))}
              {renderRowActions && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={isRowDisabled?.(row) ? "row-disabled" : undefined}>
                {visibleCols.map((col) => {
                  const isSel = selected?.rowId === row.id && selected.colKey === col.key;
                  const isEd = editing?.rowId === row.id && editing.colKey === col.key;
                  return (
                    <td
                      key={col.key}
                      data-cell={`${row.id}:${col.key}`}
                      tabIndex={-1}
                      className={isSel ? "cell-selected" : undefined}
                      style={col.width ? { width: col.width, minWidth: col.width } : undefined}
                      onClick={() => handleCellClick(row, col)}
                      onDoubleClick={() => handleCellDoubleClick(row, col)}
                      onKeyDown={(e) => handleCellKeyDown(e, row, col)}
                    >
                      {isEd && isEditableCol(col) ? (
                        <EditableCell
                          row={row}
                          column={col}
                          onDraft={(value) => scheduleTextCommit(row, col, value)}
                          onCommitKey={(dir) => {
                            flushDebounce();
                            move(dir);
                          }}
                          onCommitNow={(value) => commitValue(row, col, value)}
                          onExit={() => setEditing(null)}
                          onCancel={() => {
                            cancelDebounce();
                            setEditing(null);
                          }}
                        />
                      ) : (
                        displayValue(row, col)
                      )}
                    </td>
                  );
                })}
                {renderRowActions && <td>{renderRowActions(row)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export type { GridColumn, GridEditorType, RelationOption } from "./types";
export { Pagination, PAGE_SIZE_OPTIONS } from "./Pagination";
