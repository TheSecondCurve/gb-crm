import { useCallback, useMemo, useState } from "react";
import { can, customerTypeLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { CustomerDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { customerColumns } from "../columns/customers";
import { optionsOf } from "../columns/common";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CreateRecordModal } from "../components/CreateRecordModal";
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
  const [deleting, setDeleting] = useState<CustomerDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "customers", "create");
  const canDelete = can(role, "customers", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: CustomerDto }>(`/customers/${id}`, body);
    return res!.data;
  }, []);

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
              canDelete
                ? (row) => (
                    <button type="button" className="btn-danger" onClick={() => setDeleting(row)}>
                      删除
                    </button>
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
        <CreateRecordModal
          title="新增客户"
          columns={columns}
          requiredKeys={["nickname"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createCustomer}
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
