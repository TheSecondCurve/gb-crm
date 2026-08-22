// 我的客户：归属人是当前用户的客户（ownerId 固定等值过滤，K39 单值）。
// 复用客户列表的列定义/行内编辑/导出/修改/删除；不提供「新增」（新建行无归属人，不会出现在本列表）。
import { useCallback, useMemo, useState } from "react";
import { can, customerTypeLabels } from "@gb-crm/shared";
import { useNavigate } from "react-router-dom";

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
import { useResourceList } from "./useResourceList";

export function MyCustomersPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const navigate = useNavigate();
  const list = useResourceList<CustomerDto>("customers", "customerType", { ownerId: me?.id });
  const columns = useMemo(() => customerColumns(role), [role]);
  const [editing, setEditing] = useState<CustomerDto | null>(null);
  const [deleting, setDeleting] = useState<CustomerDto | null>(null);
  const [busy, setBusy] = useState(false);
  // K50：行级 AI 生成标签（生成中禁用）+ 全量生成（ownerId=当前用户）
  const [aiBusyId, setAiBusyId] = useState<number | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const canUpdate = can(role, "customers", "update");
  const canDelete = can(role, "customers", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: CustomerDto }>(`/customers/${id}`, body);
    return res!.data;
  }, []);

  // 导出 Excel：跟随当前搜索/类型筛选 + 固定归属人（与列表同一 WHERE）
  const exportXlsx = () => {
    const href = `/api/v1/customers/export.xlsx${buildQuery({
      q: list.q,
      customerType: list.filter,
      ownerId: me?.id,
    })}`;
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    a.click();
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

  // K50 行级 AI 打标（与客户总览「AI 生成标签」同一端点）；完成后刷新标签徽章列
  const aiGenerate = async (id: number) => {
    setAiBusyId(id);
    try {
      await api.post(`/customers/${id}/tags/generate`);
      await list.invalidate();
      showToast("AI 已更新标签");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "AI 打标失败，请稍后重试");
    } finally {
      setAiBusyId(null);
    }
  };

  // K51 全量生成标签：创建后台任务（固定 ownerId=当前用户，与导出一致），进度在业务设置-后台任务查看
  const bulkGenerate = async () => {
    setBusy(true);
    try {
      const params: Record<string, unknown> = { ownerId: me?.id };
      if (list.q) params.q = list.q;
      if (list.filter) params.customerType = list.filter;
      await api.post("/background-jobs", { type: "customer-tags-generate-all", params });
      setBulkOpen(false);
      showToast("任务已创建，可在「业务设置 → 后台任务」查看进度");
      navigate("/business-settings?tab=jobs");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建任务失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>我的客户</h1>
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
          {canUpdate && (
            <button type="button" onClick={() => setBulkOpen(true)} disabled={list.total === 0}>
              全量生成标签
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
                        <button
                          type="button"
                          disabled={aiBusyId !== null}
                          onClick={() => void aiGenerate(row.id)}
                        >
                          {aiBusyId === row.id ? "生成中…" : "AI 生成标签"}
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
      {bulkOpen && (
        <ConfirmDialog
          title="全量生成标签"
          message={`将为我的 ${list.total} 个客户创建 AI 打标任务（后台执行，每个客户一次调用）。确定继续吗？`}
          confirmText="创建任务"
          loading={busy}
          onConfirm={() => void bulkGenerate()}
          onCancel={() => setBulkOpen(false)}
        />
      )}
    </>
  );
}
