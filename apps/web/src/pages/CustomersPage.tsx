import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, customerTypeLabels } from "@gb-crm/shared";
import { useNavigate } from "react-router-dom";

import { api, ApiError, buildQuery } from "../api/client";
import type { CustomerDto, TagDto } from "../api/types";
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
  const navigate = useNavigate();
  const list = useResourceList<CustomerDto>("customers", "customerType", undefined, "tagId");
  const columns = useMemo(() => customerColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomerDto | null>(null);
  const [deleting, setDeleting] = useState<CustomerDto | null>(null);
  const [busy, setBusy] = useState(false);
  // K50：全量生成标签（跟随当前筛选；确认框展示范围）
  const [bulkOpen, setBulkOpen] = useState(false);

  const canCreate = can(role, "customers", "create");
  const canUpdate = can(role, "customers", "update");
  const canDelete = can(role, "customers", "delete");
  // K31：批量改归属人需要 updateOwners（admin/operator）；assistant 不出现选择列
  const canUpdateOwners = can(role, "customers", "updateOwners");

  // 行级批量选择：选中行在 DataGrid 由受控 selectedIds 持有；翻页/搜索/筛选/取消时清空
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchOwner, setBatchOwner] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);

  const clearSelection = () => {
    setSelectedIds([]);
    setBatchOwner("");
  };
  const changeSearch = (q: string) => {
    clearSelection();
    list.changeSearch(q);
  };
  const changeFilter = (v: string) => {
    clearSelection();
    list.changeFilter(v);
  };
  const changeSecondFilter = (v: string) => {
    clearSelection();
    list.changeSecondFilter(v);
  };
  const changePage = (p: number, ps: number) => {
    clearSelection();
    list.changePage(p, ps);
  };

  // 批量归属人选项（仅在选择条可见时拉取）
  const { data: userOptions = [] } = useQuery({
    queryKey: ["users", "batch-options"],
    enabled: canUpdateOwners && selectedIds.length > 0,
    queryFn: async () =>
      (await api.get<{ data: { id: number; nickname: string }[] }>("/users?pageSize=100"))?.data ?? [],
  });

  const applyBatchOwner = async () => {
    if (batchOwner === "") return;
    const ownerId = Number(batchOwner);
    const targets = list.rows.filter((r) => selectedIds.includes(r.id));
    setBatchBusy(true);
    try {
      // 逐行 PATCH（带各自 updatedAt 走 OCC），复用既有接口，不新开批量端点
      await Promise.all(
        targets.map((r) => api.patch(`/customers/${r.id}`, { ownerId, updatedAt: r.updatedAt })),
      );
      showToast(`已为 ${targets.length} 个客户更新归属人`);
      clearSelection();
      await list.invalidate();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "批量更新失败，请稍后重试");
      void list.invalidate();
    } finally {
      setBatchBusy(false);
      setBatchOwner("");
    }
  };

  // K45：标签筛选下拉选项（词表；空=全部）
  const { data: tagOptions = [] } = useQuery({
    queryKey: ["tags", "options"],
    queryFn: async () =>
      (await api.get<{ data: TagDto[] }>("/tags?pageSize=100"))?.data ?? [],
  });

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: CustomerDto }>(`/customers/${id}`, body);
    return res!.data;
  }, []);

  // 导出 Excel：跟随当前搜索/类型/标签筛选（与列表、bulkGenerate 同一 WHERE），同源 attachment 下载
  const exportXlsx = () => {
    const params: Record<string, string | number | boolean | null | undefined> = {};
    if (list.q) params.q = list.q;
    if (list.filter) params.customerType = list.filter;
    if (list.secondFilter) params.tagId = Number(list.secondFilter);
    const href = `/api/v1/customers/export.xlsx${buildQuery(params)}`;
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
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // K51 全量生成标签：创建后台任务（与列表同一 WHERE，跟随 q/类型/标签筛选），立即返回，进度在系统设置-后台任务查看
  const bulkGenerate = async () => {
    setBusy(true);
    try {
      const params: Record<string, unknown> = {};
      if (list.q) params.q = list.q;
      if (list.filter) params.customerType = list.filter;
      if (list.secondFilter) params.tagId = Number(list.secondFilter);
      await api.post("/background-jobs", { type: "customer-tags-generate-all", params });
      setBulkOpen(false);
      showToast("任务已创建，可在「系统设置 → 后台任务」查看进度");
      navigate("/settings?tab=jobs");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建任务失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>客户信息</h1>
        <div className="search-bar">
          <SearchBar onSearch={changeSearch} placeholder="搜索客户…" />
          <select
            aria-label="类型筛选"
            value={list.filter}
            onChange={(e) => changeFilter(e.target.value)}
          >
            <option value="">全部类型</option>
            {optionsOf(customerTypeLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            aria-label="标签筛选"
            value={list.secondFilter}
            onChange={(e) => changeSecondFilter(e.target.value)}
          >
            <option value="">全部标签</option>
            {tagOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
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
          {canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新增
            </button>
          )}
        </div>
      </div>
      <div className="card">
        {canUpdateOwners && selectedIds.length > 0 && (
          <div className="batch-bar">
            <span className="batch-count">已选 {selectedIds.length} 项</span>
            <select
              aria-label="批量归属人"
              value={batchOwner}
              onChange={(e) => setBatchOwner(e.target.value)}
            >
              <option value="">选择归属人…</option>
              {userOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nickname}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-primary"
              disabled={batchOwner === "" || batchBusy}
              onClick={() => void applyBatchOwner()}
            >
              {batchBusy ? "更新中…" : "应用归属人"}
            </button>
            <button type="button" onClick={clearSelection}>
              取消选择
            </button>
          </div>
        )}
        <div className="card-body-flush">
          <DataGrid
            ref={list.gridRef}
            gridId="customers"
            columns={columns}
            rows={list.rows}
            loading={list.loading}
            queryKey={list.queryKey}
            patchRow={patchRow}
            emptyHint={canCreate ? "点右上角「新增」创建第一条客户" : "当前筛选条件下暂无客户"}
            selectable={canUpdateOwners}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            renderRowActions={
              canUpdate || canDelete
                ? (row) => (
                    <span className="row-actions">
                      <button type="button" onClick={() => navigate(`/customers/${row.id}`)}>
                        总览
                      </button>
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
            onChange={changePage}
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
      {bulkOpen && (
        <ConfirmDialog
          title="全量生成标签"
          message={`将为当前筛选范围内的 ${list.total} 个客户创建 AI 打标任务（后台执行，每个客户一次调用）。已配置的词表之外不会新增标签。确定继续吗？`}
          confirmText="创建任务"
          loading={busy}
          onConfirm={() => void bulkGenerate()}
          onCancel={() => setBulkOpen(false)}
        />
      )}
    </>
  );
}
