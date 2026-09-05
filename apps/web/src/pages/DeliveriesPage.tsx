import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, type SystemRole } from "@gb-crm/shared";
import { useNavigate } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type { DeliveryDto, DeliveryTypeDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { dateToEpochMs, epochMsToDate, formatDateTime } from "../columns/common";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeliveryFormModal } from "../components/DeliveryFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { useResourceList } from "./useResourceList";
import type { GridColumn } from "../components/DataGrid/DataGrid";

const DATE_KEYS = new Set(["startsAt", "endsAt"]);

/** 起止日期编辑输入 YYYY-MM-DD → epoch ms；已是数字（epoch ms）直接跳过；空 = 清空（null）；非法 → 抛错 */
function convertDates(body: Record<string, unknown>): Record<string, unknown> {
  let next = body;
  for (const key of DATE_KEYS) {
    if (!(key in next)) continue;
    const v = next[key];
    if (typeof v === "number") continue;
    const ms = dateToEpochMs(v);
    if (ms === null && String(v ?? "").trim() !== "") {
      throw new Error("日期需为 YYYY-MM-DD 格式");
    }
    next = { ...next, [key]: ms };
  }
  return next;
}

function dateColumn(key: "startsAt" | "endsAt", label: string, canUpdate: boolean): GridColumn<DeliveryDto> {
  return {
    key,
    label,
    editor: "date",
    editable: canUpdate,
    getValue: (row) => epochMsToDate(row[key]),
    render: (row) => epochMsToDate(row[key]),
    applyOptimistic: (row, v) => ({ ...row, [key]: dateToEpochMs(v) }),
  };
}

function deliveryColumns(role: SystemRole | null): GridColumn<DeliveryDto>[] {
  const canUpdate = can(role, "deliveries", "update");
  return [
    {
      key: "name",
      label: "交付名",
      editor: "text",
      editable: canUpdate,
      render: (row: DeliveryDto) => row.name || "—",
    },
    {
      key: "deliveryType",
      label: "交付类型",
      editable: false,
      render: (row: DeliveryDto) => row.deliveryType?.name ?? "—",
    },
    {
      key: "customerCount",
      label: "客户数",
      editable: false,
      render: (row: DeliveryDto) => `${row.customers.length} 人`,
    },
    dateColumn("startsAt", "开始日期", canUpdate),
    dateColumn("endsAt", "结束日期", canUpdate),
    {
      key: "remark",
      label: "备注",
      editor: "textarea",
      editable: canUpdate,
      render: (row: DeliveryDto) => row.remark || "—",
    },
    {
      key: "updatedAt",
      label: "更新时间",
      editable: false,
      render: (row: DeliveryDto) => formatDateTime(row.updatedAt),
    },
    { key: "id", label: "ID", editable: false },
    {
      key: "createdAt",
      label: "创建时间",
      editable: false,
      render: (row: DeliveryDto) => formatDateTime(row.createdAt),
    },
  ];
}

export function DeliveriesPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const navigate = useNavigate();
  const list = useResourceList<DeliveryDto>("deliveries", "deliveryTypeId");
  const columns = useMemo(() => deliveryColumns(role), [role]);
  // 交付类型 tab 选项：全部 live（含失效）类型都展示，保证已有交付单都能筛到；按名称排稳定序
  const { data: typeOptions = [] } = useQuery({
    queryKey: ["delivery-types", "options"],
    queryFn: async () =>
      (await api.get<{ data: DeliveryTypeDto[] }>("/delivery-types?pageSize=100"))?.data ?? [],
  });
  const sortedTypes = useMemo(
    () => [...typeOptions].sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [typeOptions],
  );
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<DeliveryDto | null>(null);
  const [deleting, setDeleting] = useState<DeliveryDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "deliveries", "create");
  const canUpdate = can(role, "deliveries", "update");
  const canDelete = can(role, "deliveries", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    const res = await api.patch<{ data: DeliveryDto }>(`/deliveries/${id}`, convertDates(body));
    return res!.data;
  }, []);

  const saveDelivery = async (body: Record<string, unknown>, existing: DeliveryDto | null) => {
    setBusy(true);
    try {
      if (existing) {
        await patchRow(existing.id, body);
      } else {
        await api.post<{ data: DeliveryDto }>("/deliveries", convertDates(body));
      }
      setCreating(false);
      setEditing(null);
      await list.invalidate();
      showToast(existing ? "已保存" : "已创建交付");
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
      await api.delete(`/deliveries/${deleting.id}`);
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
        <h1>交付管理</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索日期/客户/名称…" />
          {canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新增交付
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <div className="tabs" role="tablist" aria-label="按交付类型筛选">
          <button
            type="button"
            role="tab"
            aria-selected={list.filter === ""}
            onClick={() => list.changeFilter("")}
          >
            全部
          </button>
          {sortedTypes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={list.filter === String(t.id)}
              onClick={() => list.changeFilter(String(t.id))}
            >
              {t.name}
            </button>
          ))}
        </div>
        <div className="card-body-flush">
          <DataGrid
            ref={list.gridRef}
            gridId="deliveries"
            columns={columns}
            rows={list.rows}
            loading={list.loading}
            queryKey={list.queryKey}
            patchRow={patchRow}
            renderRowActions={
              canUpdate || canDelete
                ? (row) => (
                    <span className="row-actions">
                      {row.deliveryType?.kind === "circle" && (
                        <button type="button" onClick={() => navigate(`/deliveries/${row.id}/circle`)}>
                          圈子工作台
                        </button>
                      )}
                      <button type="button" onClick={() => navigate(`/deliveries/${row.id}`)}>
                        详情
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
                : (row) => (
                    <span className="row-actions">
                      {row.deliveryType?.kind === "circle" && (
                        <button type="button" onClick={() => navigate(`/deliveries/${row.id}/circle`)}>
                          圈子工作台
                        </button>
                      )}
                      <button type="button" onClick={() => navigate(`/deliveries/${row.id}`)}>
                        详情
                      </button>
                    </span>
                  )
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
        <DeliveryFormModal
          title="新增交付"
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(body) => saveDelivery(body, null)}
        />
      )}
      {editing && (
        <DeliveryFormModal
          title={`修改交付：${editing.name ?? editing.deliveryType?.name ?? `#${editing.id}`}`}
          delivery={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => saveDelivery(body, editing)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除交付"
          message={`确定删除交付「${deleting.name ?? deleting.deliveryType?.name ?? `#${deleting.id}`}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
