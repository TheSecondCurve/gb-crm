import { useCallback, useMemo, useState } from "react";
import { can, productStatusLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { ProductDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { optionsOf, yuanToCents } from "../columns/common";
import { productColumns } from "../columns/products";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

export function ProductsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<ProductDto>("products", "status");
  const columns = useMemo(() => productColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ProductDto | null>(null);
  const [deleting, setDeleting] = useState<ProductDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "products", "create");
  const canUpdate = can(role, "products", "update");
  const canDelete = can(role, "products", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    // K13：价格编辑输入元 → Math.round(yuan*100) 分；isPackage select "true"/"false" → boolean。
    // 非法数字抛错（队列 toast + 回滚），禁止静默写 null 清空价格；"" 保持清空语义
    if ("priceCents" in body) {
      const cents = yuanToCents(body.priceCents);
      if (cents === null && String(body.priceCents ?? "").trim() !== "") {
        throw new Error("价格需为数字（元）");
      }
      body = { ...body, priceCents: cents };
    }
    if ("isPackage" in body) body = { ...body, isPackage: body.isPackage === "true" };
    const res = await api.patch<{ data: ProductDto }>(`/products/${id}`, body);
    return res!.data;
  }, []);

  // 新增：先弹字段表单，确认后才 POST（不再直接插空行）
  const createProduct = async (body: Record<string, unknown>) => {
    if ("priceCents" in body) {
      const cents = yuanToCents(body.priceCents);
      if (cents === null) {
        showToast("价格需为数字（元）");
        return;
      }
      body = { ...body, priceCents: cents };
    }
    if ("isPackage" in body) body = { ...body, isPackage: body.isPackage === "true" };
    setBusy(true);
    try {
      const res = await api.post<{ data: ProductDto }>("/products", body);
      setCreating(false);
      await list.invalidate();
      showToast("已创建产品");
      if (res?.data) focusEditableCell(res.data.id, "name");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // 修改：同一表单弹窗全字段编辑，PATCH 只带变更键（OCC 由弹窗附 updatedAt）
  const updateProduct = async (id: number, body: Record<string, unknown>) => {
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
      await api.delete(`/products/${deleting.id}`);
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
        <h1>产品目录</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索产品…" />
          <select
            aria-label="状态筛选"
            value={list.filter}
            onChange={(e) => list.changeFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            {optionsOf(productStatusLabels).map((o) => (
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
            gridId="products"
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
          title="新增产品"
          columns={columns}
          requiredKeys={["name"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createProduct}
        />
      )}
      {editing && (
        <RecordFormModal
          title={`修改产品：${editing.name}`}
          columns={columns}
          requiredKeys={["name"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateProduct(editing.id, body)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除产品"
          message={`确定删除产品「${deleting.name}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
