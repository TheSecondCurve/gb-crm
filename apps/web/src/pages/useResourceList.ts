// 四张主数据页共用的列表骨架（design.md §7.11 / K25）：
// page/pageSize/q/一个过滤下拉进 react-query queryKey；翻页/搜索/改过滤前先 flushAll。
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListEnvelope } from "@gb-crm/shared";

import { api, buildQuery } from "../api/client";
import type { DataGridHandle } from "../components/DataGrid/DataGrid";
import type { GridRow } from "../components/DataGrid/types";

export interface ResourceList<T extends GridRow> {
  gridRef: React.RefObject<DataGridHandle | null>;
  page: number;
  pageSize: number;
  q: string;
  filter: string;
  queryKey: readonly unknown[];
  rows: T[];
  total: number;
  loading: boolean;
  /** 翻页 / 改 pageSize：先 flush 行内 PATCH 队列再切（§7.6） */
  changePage: (page: number, pageSize: number) => void;
  changeSearch: (q: string) => void;
  changeFilter: (value: string) => void;
  invalidate: () => Promise<void>;
}

export function useResourceList<T extends GridRow>(
  resource: string,
  filterKey: string,
  /** 固定过滤参数（如「我的客户」ownerId=当前用户），并入 query 与 queryKey */
  fixedQuery?: Record<string, string | number | undefined>,
): ResourceList<T> {
  const queryClient = useQueryClient();
  const gridRef = useRef<DataGridHandle>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");

  const queryKey = [resource, page, pageSize, q, filter, fixedQuery] as const;
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () =>
      (await api.get<ListEnvelope<T>>(
        `/${resource}${buildQuery({ page, pageSize, q, [filterKey]: filter, ...fixedQuery })}`,
      )) ?? { data: [], meta: { page, pageSize, total: 0 } },
  });

  const changePage = (nextPage: number, nextPageSize: number) => {
    void (async () => {
      await gridRef.current?.flushAll();
      setPage(nextPage);
      setPageSize(nextPageSize);
    })();
  };
  const changeSearch = (value: string) => {
    void gridRef.current?.flushAll();
    setQ(value);
    setPage(1);
  };
  const changeFilter = (value: string) => {
    void gridRef.current?.flushAll();
    setFilter(value);
    setPage(1);
  };
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [resource] });

  return {
    gridRef,
    page,
    pageSize,
    q,
    filter,
    queryKey,
    rows: data?.data ?? [],
    total: data?.meta.total ?? 0,
    loading: isLoading,
    changePage,
    changeSearch,
    changeFilter,
    invalidate,
  };
}

/** 新增成功后尽力 focus 该行首个可编辑格并进入编辑（§7.7） */
export function focusEditableCell(rowId: number, colKey: string): void {
  setTimeout(() => {
    const cell = document.querySelector<HTMLElement>(`[data-cell="${rowId}:${colKey}"]`);
    if (!cell) return;
    cell.focus();
    cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }, 0);
}
