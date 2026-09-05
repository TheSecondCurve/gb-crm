// 我的成交：负责人是当前用户的成交记录（ownerId 固定等值过滤，K42 单值）。
// 复用成交列表的列定义/行内编辑/修改/删除；不提供「新增」（新建行负责人不是当前用户，不会出现在本列表）。
import { useCallback, useMemo, useState } from "react";
import { can, dealStageLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { DealDto } from "../api/types";
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
import { useResourceList } from "./useResourceList";

export function MyDealsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  // 多维筛选（负责人固定为当前用户，故筛选条不显示负责人）
  const [filters, setFilters] = useState<DealFilterValues>(EMPTY_DEAL_FILTERS);
  const dealQuery = useMemo(
    () => ({ ...dealFiltersToQuery(filters), ownerId: me?.id }),
    [filters, me?.id],
  );
  const list = useResourceList<DealDto>("deals", "stage", dealQuery);
  const columns = useMemo(() => dealColumns(role), [role]);
  const [editing, setEditing] = useState<DealDto | null>(null);
  const [deleting, setDeleting] = useState<DealDto | null>(null);
  const [busy, setBusy] = useState(false);

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
        <h1>我的成交</h1>
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
          <DealFilterBar value={filters} onChange={changeFilters} showOwner={false} />
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
