// 业务设置页（K45/K50）：客户标签词表（admin 写、其余只读）。后台任务已移至系统设置页（K51）。
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can, tagScopeLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { TagDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, optionsOf, type BadgeTone } from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

const TAG_SCOPE_TONES: Record<string, BadgeTone> = {
  identity: "accent",
  stage: "plain",
  interest: "accent",
  other: "muted",
};

export function BusinessSettingsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [editingTag, setEditingTag] = useState<TagDto | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [deletingTag, setDeletingTag] = useState<TagDto | null>(null);

  const canRead = can(role, "tags", "read");
  const canManage = can(role, "tags", "create") && can(role, "tags", "update");
  const canDelete = can(role, "tags", "delete");

  const { data: tags = [], refetch: refetchTags } = useQuery({
    queryKey: ["tags", "manage"],
    queryFn: async () =>
      (await api.get<{ data: TagDto[] }>("/tags?pageSize=100"))?.data ?? [],
    enabled: canRead,
  });

  const scopeOptions = optionsOf(tagScopeLabels);

  const toastError = (err: unknown, fallback: string) =>
    showToast(err instanceof ApiError ? err.message : fallback);

  const submitTag = async (body: Record<string, unknown>, tag: TagDto | null) => {
    setBusy(true);
    try {
      if (tag) {
        await api.patch(`/tags/${tag.id}`, { ...body, updatedAt: tag.updatedAt });
      } else {
        await api.post("/tags", body);
      }
      setCreatingTag(false);
      setEditingTag(null);
      await refetchTags();
      await queryClient.invalidateQueries({ queryKey: ["tags", "options"] });
      showToast("已保存标签");
    } catch (err) {
      toastError(err, "保存标签失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteTag = async () => {
    if (!deletingTag) return;
    setBusy(true);
    try {
      await api.delete(`/tags/${deletingTag.id}`);
      setDeletingTag(null);
      await refetchTags();
      await queryClient.invalidateQueries({ queryKey: ["tags", "options"] });
      showToast("已删除标签");
    } catch (err) {
      toastError(err, "删除失败");
    } finally {
      setBusy(false);
    }
  };

  if (!canRead) {
    return (
      <div className="page-head">
        <h1>业务设置</h1>
        <div className="task-empty">没有权限访问业务设置</div>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>业务设置</h1>
      </div>

      <div className="settings-section">
          <div className="card">
            <div className="card-head">
              <h2>客户标签词表</h2>
              {canManage && (
                <button type="button" className="btn-primary" onClick={() => setCreatingTag(true)}>
                  新增标签
                </button>
              )}
            </div>
            <div className="card-body-flush">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>标签名</th>
                    <th>分类</th>
                    <th>排序</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {tags.map((t) => (
                    <tr key={t.id}>
                      <td>{badge(t.name, TAG_SCOPE_TONES[t.scope] ?? "muted")}</td>
                      <td>{tagScopeLabels[t.scope as keyof typeof tagScopeLabels] ?? t.scope}</td>
                      <td>{t.sort}</td>
                      <td>{t.enabled ? "启用" : "停用"}</td>
                      <td className="row-actions">
                        {canManage && (
                          <>
                            <button type="button" onClick={() => setEditingTag(t)}>
                              修改
                            </button>
                            {canDelete && (
                              <button type="button" className="btn-danger" onClick={() => setDeletingTag(t)}>
                                删除
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      {(creatingTag || editingTag) && (
        <TagFormModal
          title={creatingTag ? "新增标签" : `修改标签：${editingTag?.name}`}
          tag={editingTag}
          scopeOptions={scopeOptions}
          busy={busy}
          onClose={() => {
            setCreatingTag(false);
            setEditingTag(null);
          }}
          onSubmit={(body) => submitTag(body, editingTag)}
        />
      )}
      {deletingTag && (
        <ConfirmDialog
          title="删除标签"
          message={`确定删除标签「${deletingTag.name}」吗？已打标的客户将不再显示该标签。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDeleteTag()}
          onCancel={() => setDeletingTag(null)}
        />
      )}
    </>
  );
}

interface TagFormModalProps {
  title: string;
  tag: TagDto | null;
  scopeOptions: { value: string; label: string }[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

/** 标签小表单（name/scope/sort/enabled；不套 RecordFormModal——sort 是数字） */
function TagFormModal({ title, tag, scopeOptions, busy, onClose, onSubmit }: TagFormModalProps) {
  const [name, setName] = useState(tag?.name ?? "");
  const [scope, setScope] = useState(tag?.scope ?? "other");
  const [sort, setSort] = useState(String(tag?.sort ?? 0));
  const [enabled, setEnabled] = useState(tag?.enabled ?? true);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (tag === null || tag.name !== name.trim()) body.name = name.trim();
    if (tag === null || tag.scope !== scope) body.scope = scope;
    const sortNum = Number(sort);
    if (Number.isFinite(sortNum) && (tag === null || tag.sort !== sortNum)) body.sort = sortNum;
    if (tag === null || tag.enabled !== enabled) body.enabled = enabled;
    await onSubmit(body);
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        <label className="field">
          标签名
          <input required value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          分类
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          排序
          <input type="number" min={0} value={sort} onChange={(e) => setSort(e.target.value)} />
        </label>
        <label className="field">
          状态
          <select
            value={enabled ? "true" : "false"}
            onChange={(e) => setEnabled(e.target.value === "true")}
          >
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
        </label>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {tag ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
