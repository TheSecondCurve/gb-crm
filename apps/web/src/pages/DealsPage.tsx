import { useCallback, useMemo, useState } from "react";
import { can, dealStageLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { DealDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { optionsOf } from "../columns/common";
import { dateToEpochMs, dealColumns } from "../columns/deals";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

export function DealsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<DealDto>("deals", "stage");
  const columns = useMemo(() => dealColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DealDto | null>(null);
  const [deleting, setDeleting] = useState<DealDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "deals", "create");
  const canUpdate = can(role, "deals", "update");
  const canDelete = can(role, "deals", "delete");

  /** 交付日期编辑输入 YYYY-MM-DD → epoch ms；空 = 清空（null）；非法 → 抛错（队列 toast） */
  const convertDeliveryDate = (body: Record<string, unknown>): Record<string, unknown> => {
    if (!("deliveryDate" in body)) return body;
    const ms = dateToEpochMs(body.deliveryDate);
    if (ms === null && String(body.deliveryDate ?? "").trim() !== "") {
      throw new Error("交付日期需为 YYYY-MM-DD 格式");
    }
    return { ...body, deliveryDate: ms };
  };

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: DealDto }>(`/deals/${id}`, convertDeliveryDate(body));
    return res!.data;
  }, []);

  // 新增：先弹字段表单，确认后才 POST（不再直接插空行）
  const createDeal = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: DealDto }>("/deals", convertDeliveryDate(body));
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
