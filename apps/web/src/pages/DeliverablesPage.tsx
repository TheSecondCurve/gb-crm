import { useCallback, useMemo, useState } from "react";
import { can, deliverableStatusLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { DeliverableDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { dateToEpochMs, optionsOf } from "../columns/common";
import { deliverableColumns } from "../columns/deliverables";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { TaskModal } from "../components/TaskModal";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

/** 交付日期列：YYYY-MM-DD → epoch ms；空 = 清空；非法 → 抛错（队列 toast） */
function convertDates(body: Record<string, unknown>): Record<string, unknown> {
  const keys = ["planDeliverDate", "actualDeliverDate", "expiryDate"] as const;
  let next = body;
  for (const key of keys) {
    if (!(key in next)) continue;
    const ms = dateToEpochMs(next[key]);
    if (ms === null && String(next[key] ?? "").trim() !== "") {
      throw new Error("交付日期需为 YYYY-MM-DD 格式");
    }
    next = { ...next, [key]: ms };
  }
  return next;
}

export function DeliverablesPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<DeliverableDto>("deliverables", "status");
  const columns = useMemo(() => deliverableColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DeliverableDto | null>(null);
  const [deleting, setDeleting] = useState<DeliverableDto | null>(null);
  const [tasksOf, setTasksOf] = useState<DeliverableDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "deliverables", "create");
  const canUpdate = can(role, "deliverables", "update");
  const canDelete = can(role, "deliverables", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: DeliverableDto }>(`/deliverables/${id}`, convertDates(body));
    return res!.data;
  }, []);

  const createDeliverable = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: DeliverableDto }>("/deliverables", convertDates(body));
      setCreating(false);
      await list.invalidate();
      showToast("已创建交付项");
      if (res?.data) focusEditableCell(res.data.id, "status");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const updateDeliverable = async (id: number, body: Record<string, unknown>) => {
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
      await api.delete(`/deliverables/${deleting.id}`);
      setDeleting(null);
      await list.invalidate();
      showToast("已删除");
    } finally {
      setBusy(false);
    }
  };

  const dealLabel = (d: DeliverableDto) =>
    `${d.deal?.orderNo ?? ""}${d.deal?.orderNo && d.deal?.customer ? " · " : ""}${d.deal?.customer?.nickname ?? ""}`.trim() || `#${d.id}`;

  return (
    <>
      <div className="page-head">
        <h1>交付管理</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索客户…" />
          <select
            aria-label="状态筛选"
            value={list.filter}
            onChange={(e) => list.changeFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            {optionsOf(deliverableStatusLabels).map((o) => (
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
            gridId="deliverables"
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
                        <button type="button" onClick={() => setTasksOf(row)}>
                          动作
                        </button>
                      )}
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
          title="新增交付项"
          columns={columns}
          requiredKeys={["deal"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createDeliverable}
        />
      )}
      {editing && (
        <RecordFormModal
          title={`修改交付项：${dealLabel(editing)}`}
          columns={columns}
          requiredKeys={["deal"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateDeliverable(editing.id, body)}
        />
      )}
      {tasksOf && (
        <TaskModal
          deliverable={tasksOf}
          onClose={() => setTasksOf(null)}
          onChange={() => list.invalidate()}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除交付项"
          message={`确定删除「${dealLabel(deleting)}」的交付项吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
