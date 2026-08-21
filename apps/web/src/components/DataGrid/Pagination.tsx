/** 分页（design.md §7.10 / K25）：共 N 条 + 上一页/下一页 + 页码 + pageSize <select> 25/50/100 */

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  /** 改 pageSize 时调用方应回到第 1 页（此处直接给 page=1） */
  onChange: (page: number, pageSize: number) => void;
}

/** 页码窗口：总数 ≤7 全显，否则当前页 ±2 并带上首尾 */
function pageNumbers(page: number, pageCount: number): (number | "…")[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const set = new Set<number>([1, pageCount]);
  for (let p = page - 2; p <= page + 2; p++) {
    if (p >= 1 && p <= pageCount) set.add(p);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev > 0 && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pagination({ page, pageSize, total, onChange }: PaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="pagination">
      <span className="total">共 {total} 条</span>
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1, pageSize)}>
        上一页
      </button>
      {pageNumbers(page, pageCount).map((p, i) =>
        p === "…" ? (
          <span key={`ellipsis-${i}`}>…</span>
        ) : (
          <button
            key={p}
            type="button"
            className={p === page ? "btn-primary" : undefined}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onChange(p, pageSize)}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1, pageSize)}
      >
        下一页
      </button>
      <select
        aria-label="每页条数"
        value={pageSize}
        onChange={(e) => onChange(1, Number(e.target.value))}
      >
        {PAGE_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size} 条/页
          </option>
        ))}
      </select>
    </div>
  );
}
