import { useCallback, useMemo, useState } from "react";
import { can, channelStatusLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { ChannelDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { channelColumns } from "../columns/channels";
import { optionsOf } from "../columns/common";
import { DataGrid, Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordFormModal } from "../components/RecordFormModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { focusEditableCell, useResourceList } from "./useResourceList";

export function ChannelsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const list = useResourceList<ChannelDto>("channels", "status");
  const columns = useMemo(() => channelColumns(role), [role]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ChannelDto | null>(null);
  const [deleting, setDeleting] = useState<ChannelDto | null>(null);
  const [busy, setBusy] = useState(false);

  const canCreate = can(role, "channels", "create");
  const canUpdate = can(role, "channels", "update");
  const canDelete = can(role, "channels", "delete");

  const patchRow = useCallback(async (id: number, body: Record<string, unknown>) => {
    // followerCount 由文本编辑器产生："" → null，否则转 number
    if ("followerCount" in body) {
      const s = String(body.followerCount ?? "").trim();
      body = { ...body, followerCount: s === "" ? null : Number(s) };
    }
    const res = await api.patch<{ data: ChannelDto }>(`/channels/${id}`, body);
    return res!.data;
  }, []);

  // 新增：先弹字段表单，确认后才 POST（不再直接插空行）
  const createChannel = async (body: Record<string, unknown>) => {
    if ("followerCount" in body) {
      const n = Number(body.followerCount);
      if (!Number.isFinite(n)) {
        showToast("粉丝/好友数需为数字");
        return;
      }
      body = { ...body, followerCount: n };
    }
    setBusy(true);
    try {
      const res = await api.post<{ data: ChannelDto }>("/channels", body);
      setCreating(false);
      await list.invalidate();
      showToast("已创建渠道");
      if (res?.data) focusEditableCell(res.data.id, "name");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // 修改：同一表单弹窗全字段编辑，PATCH 只带变更键（OCC 由弹窗附 updatedAt）
  const updateChannel = async (id: number, body: Record<string, unknown>) => {
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
      await api.delete(`/channels/${deleting.id}`);
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
        <h1>渠道资产</h1>
        <div className="search-bar">
          <SearchBar onSearch={list.changeSearch} placeholder="搜索渠道…" />
          <select
            aria-label="状态筛选"
            value={list.filter}
            onChange={(e) => list.changeFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            {optionsOf(channelStatusLabels).map((o) => (
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
            gridId="channels"
            columns={columns}
            rows={list.rows}
            loading={list.loading}
            queryKey={list.queryKey}
            patchRow={patchRow}
            isRowDisabled={(row) => row.status === "paused"}
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
          title="新增渠道"
          columns={columns}
          requiredKeys={["name"]}
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={createChannel}
        />
      )}
      {editing && (
        <RecordFormModal
          title={`修改渠道：${editing.name}`}
          columns={columns}
          requiredKeys={["name"]}
          row={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body) => updateChannel(editing.id, body)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除渠道"
          message={`确定删除渠道「${deleting.name}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
