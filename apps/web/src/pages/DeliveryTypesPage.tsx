import { useCallback, useMemo, useState } from "react";
import { can, deliveryTypeKindLabels, deliveryTypeStatusLabels, type SystemRole } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { DeliveryTypeDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { optionsOf } from "../columns/common";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";
import type { GridColumn } from "../components/DataGrid/DataGrid";

/** K44 交付类型配置表页：名称 + 分类 + 状态 + 说明 + 默认动作模板（多行文本，每行一个动作） */
function deliveryTypeColumns(role: SystemRole | null): GridColumn<DeliveryTypeDto>[] {
  const canUpdate = can(role, "deliveries", "update");
  return [
    { key: "name", label: "类型名称", editor: "text", editable: canUpdate },
    {
      key: "kind",
      label: "类型",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(deliveryTypeKindLabels),
      render: (row: DeliveryTypeDto) => deliveryTypeKindLabels[row.kind as keyof typeof deliveryTypeKindLabels] ?? row.kind,
    },
    {
      key: "status",
      label: "状态",
      editor: "select",
      editable: canUpdate,
      options: optionsOf(deliveryTypeStatusLabels),
      render: (row: DeliveryTypeDto) => deliveryTypeStatusLabels[row.status as keyof typeof deliveryTypeStatusLabels] ?? row.status,
    },
    { key: "description", label: "说明", editor: "textarea", editable: canUpdate },
    {
      key: "defaultTasks",
      label: "默认动作模板",
      editor: "textarea",
      editable: canUpdate,
      render: (row: DeliveryTypeDto) => row.defaultTasks || "—",
    },
    { key: "id", label: "ID", editable: false },
    {
      key: "createdAt",
      label: "创建时间",
      editable: false,
      render: (row: DeliveryTypeDto) => new Date(row.createdAt).toLocaleString("zh-CN", { hour12: false }),
    },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row: DeliveryTypeDto) => new Date(row.updatedAt).toLocaleString("zh-CN", { hour12: false }),
    },
  ];
}

export function DeliveryTypesPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  // 类型页只有 q 搜索、无过滤下拉；filterKey 用占位键（filter 恒为空串，buildQuery 跳过）
  const list = useResourceList<DeliveryTypeDto>("delivery-types", "unused");
  const columns = useMemo(() => deliveryTypeColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DeliveryTypeDto | null>(null);
  const [deleting, setDeleting] = useState<DeliveryTypeDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "deliveries", "create");
  const canUpdate = can(role, "deliveries", "update");
  const canDelete = can(role, "deliveries", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: DeliveryTypeDto }>(`/delivery-types/${id}`, body);
    return res!.data;
  }, []);

  const createType = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: DeliveryTypeDto }>("/delivery-types", body);
      setCreating(false);
      await list.invalidate();
      showToast("已创建交付类型");
      if (res?.data) focusEditableCell(res.data.id, "name");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const updateType = async (id: number, body: Record<string, unknown>) => {
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
      await api.delete(`/delivery-types/${deleting.id}`);
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
        <h1>交付类型</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索类型…" />
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
            gridId="delivery-types"
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
          title="新增交付类型"
          columns={columns}
          requiredKeys={["name"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createType}
        />
      )}
      {editing && (
        <RecordFormModal
          title={`修改交付类型：${editing.name}`}
          columns={columns}
          requiredKeys={["name"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateType(editing.id, body)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除交付类型"
          message={`确定删除交付类型「${deleting.name}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
