import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, dealStageLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { DealDto, ProductDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { optionsOf } from "../columns/common";
import { convertDealBody, dealColumns } from "../columns/deals";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  DealFilterBar,
  dealFiltersToQuery,
  EMPTY_DEAL_FILTERS,
  type DealFilterValues,
} from "../components/DealFilterBar";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

export function DealsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  // 多维筛选（客户/负责人/客户归属人/成交与交付日期范围/交付日期空否）→ 并入列表 query 与 queryKey
  const [filters, setFilters] = useState<DealFilterValues>(EMPTY_DEAL_FILTERS);
  const dealQuery = useMemo(() => dealFiltersToQuery(filters), [filters]);
  const list = useResourceList<DealDto>("deals", "stage", dealQuery, "productId");
  const columns = useMemo(() => dealColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DealDto | null>(null);
  const [deleting, setDeleting] = useState<DealDto | null>(null);
  const [busy, setBusy] = useState(false);

  // 产品筛选下拉选项（意向产品词表；空=全部）
  const { data: productOptions = [] } = useQuery({
    queryKey: ["products", "options"],
    queryFn: async () =>
      (await api.get<{ data: ProductDto[] }>("/products?pageSize=100"))?.data ?? [],
  });

  const canCreate = can(role, "deals", "create");
  const canUpdate = can(role, "deals", "update");
  const canDelete = can(role, "deals", "delete");

  // 改筛选：先 flush 行内 PATCH 队列再回第一页（与 useResourceList.changeFilter 同语义）
  const changeFilters = (next: DealFilterValues) => {
    void list.gridRef.current?.flushAll();
    setFilters(next);
    list.changePage(1, list.pageSize);
  };

  /** POST/PATCH body 转换唯一实现见 columns/deals.convertDealBody（行内编辑 / 弹窗共用） */
  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: DealDto }>(`/deals/${id}`, convertDealBody(body));
    return res!.data;
  }, []);

  // 新增：先弹字段表单，确认后才 POST（不再直接插空行）
  const createDeal = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: DealDto }>("/deals", convertDealBody(body));
      setCreating(false);
      await list.invalidate();
      showToast("已创建成交记录");
      if (res?.data) focusEditableCell(res.data.id, "customer");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // 修改：同一表单弹窗全字段编辑，PATCH 只带变更键（OCC 由弹窗附 updatedAt）
  const updateDeal = async (id: number, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await patchRow(id, body);
      setEditing(null);
      await list.invalidate();
      showToast("已保存");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该行已被他人更新，请刷新后重试"
          : err instanceof Error
            ? err.message
            : "保存失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/deals/${deleting.id}`);
      setDeleting(null);
      await list.invalidate();
      showToast("已删除");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>成交记录</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索订单号/备注…" />
          <select
            aria-label="阶段筛选"
            value={list.filter}
            onChange={(e) => list.changeFilter(e.target.value)}
          >
            <option value="">全部阶段</option>
            {optionsOf(dealStageLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            aria-label="产品筛选"
            value={list.secondFilter}
            onChange={(e) => list.changeSecondFilter(e.target.value)}
          >
            <option value="">全部产品</option>
            {productOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <DealFilterBar value={filters} onChange={changeFilters} />
          {canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新增
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <div className="card-body-flush">
          <DataGrid
            ref={list.gridRef}
            gridId="deals"
            columns={columns}
            rows={list.rows}
            loading={list.loading}
            queryKey={list.queryKey}
            patchRow={patchRow}
            renderRowActions={
              canUpdate || canDelete
                ? (row) => (
                    <span className="row-actions">
                      {canUpdate && (
                        <button type="button" onClick={() => setEditing(row)}>
                          修改
                        </button>
                      )}
                      {canDelete && (
                        <button type="button" className="btn-danger" onClick={() => setDeleting(row)}>
                          删除
                        </button>
                      )}
                    </span>
                  )
                : undefined
            }
          />
        </div>
        <div className="card-footer">
          <Pagination
            page={list.page}
            pageSize={list.pageSize}
            total={list.total}
            onChange={list.changePage}
          />
        </div>
      </div>
      {creating && (
        <RecordFormModal
          title="新增成交记录"
          columns={columns}
          requiredKeys={["customer"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createDeal}
        />
      )}
      {editing && (
        <RecordFormModal
          title={`修改成交记录：${editing.customer?.nickname ?? `#${editing.id}`}`}
          columns={columns}
          requiredKeys={["customer"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateDeal(editing.id, body)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除成交记录"
          message={`确定删除「${deleting.customer?.nickname ?? `#${deleting.id}`}」的成交记录吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
