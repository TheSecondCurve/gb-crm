import { useCallback, useMemo, useState } from "react";
import { can, productStatusLabels } from "@gb-crm/shared";

import { api } from "../api/client";
import type { ProductDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { optionsOf } from "../columns/common";
import { productColumns, yuanToCents } from "../columns/products";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

export function ProductsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<ProductDto>("products", "status");
  const columns = useMemo(() => productColumns(role), [role]);
  const [deleting, setDeleting] = useState<ProductDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "products", "create");
  const canDelete = can(role, "products", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    // K13：价格编辑输入元 → Math.round(yuan*100) 分；isPackage select "true"/"false" → boolean
    if ("priceCents" in body) body = { ...body, priceCents: yuanToCents(body.priceCents) };
    if ("isPackage" in body) body = { ...body, isPackage: body.isPackage === "true" };
    const res = await api.patch<{ data: ProductDto }>(`/products/${id}`, body);
    return res!.data;
  }, []);

  const createRow = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ data: ProductDto }>("/products", { name: "未命名产品" });
      await list.invalidate();
      if (res?.data) focusEditableCell(res.data.id, "name");
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
            <button type="button" className="btn-primary" onClick={() => void createRow()} disabled={busy}>
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
