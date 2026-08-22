import { useCallback, useMemo, useState } from "react";
import { can, customerTypeLabels } from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import type { CustomerDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { customerColumns } from "../columns/customers";
import { optionsOf } from "../columns/common";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

export function CustomersPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<CustomerDto>("customers", "customerType");
  const columns = useMemo(() => customerColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomerDto | null>(null);
  const [deleting, setDeleting] = useState<CustomerDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "customers", "create");
  const canUpdate = can(role, "customers", "update");
  const canDelete = can(role, "customers", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: CustomerDto }>(`/customers/${id}`, body);
    return res!.data;
  }, []);

  // 导出 Excel：跟随当前搜索/类型筛选，同源 attachment 下载（不离开当前页）
  const exportXlsx = () => {
    const href = `/api/v1/customers/export.xlsx${buildQuery({ q: list.q, customerType: list.filter })}`;
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    a.click();
  };

  // 新增：先弹字段表单，确认后才 POST（不再直接插空行）
  const createCustomer = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: CustomerDto }>("/customers", body);
      setCreating(false);
      await list.invalidate();
      showToast("已创建客户");
      if (res?.data) focusEditableCell(res.data.id, "nickname");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // 修改：同一表单弹窗全字段编辑，PATCH 只带变更键（OCC 由弹窗附 updatedAt）
  const updateCustomer = async (id: number, body: Record<string, unknown>) => {
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
          : err instanceof ApiError
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
      await api.delete(`/customers/${deleting.id}`);
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
        <h1>客户信息</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索客户…" />
          <select
            aria-label="类型筛选"
            value={list.filter}
            onChange={(e) => list.changeFilter(e.target.value)}
          >
            <option value="">全部类型</option>
            {optionsOf(customerTypeLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={exportXlsx}>
            导出 Excel
          </button>
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
            gridId="customers"
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
          title="新增客户"
          columns={columns}
          requiredKeys={["nickname"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createCustomer}
        />
      )}
      {editing && (
        <RecordFormModal
          title={`修改客户：${editing.nickname}`}
          columns={columns}
          requiredKeys={["nickname"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateCustomer(editing.id, body)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除客户"
          message={`确定删除客户「${deleting.nickname}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
