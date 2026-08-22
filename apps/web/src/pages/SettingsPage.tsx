// 系统设置页（K45/K46）：LLM 打标配置（仅 admin）+ 标签词表维护（仅 admin）。
// 路由守卫：can(system, read) 否则显示无权限；侧栏入口同样按 can 显隐。
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can, tagScopeLabels } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { AiConfigDto, TagDto } from "../api/types";
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

export function SettingsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const canManage = can(role, "system", "read") && can(role, "system", "update");
  const canManageTags = can(role, "tags", "create") && can(role, "tags", "update");

  const { data: aiConfig } = useQuery({
    queryKey: ["system", "ai-config"],
    queryFn: async () =>
      (await api.get<{ data: AiConfigDto }>("/system/ai-config"))?.data,
    enabled: canManage,
  });

  const { data: tags = [], refetch: refetchTags } = useQuery({
    queryKey: ["tags", "manage"],
    queryFn: async () =>
      (await api.get<{ data: TagDto[] }>("/tags?pageSize=100"))?.data ?? [],
    enabled: canManage,
  });

  const [form, setForm] = useState({ provider: "", baseUrl: "", model: "", apiKey: "" });
  const [editingTag, setEditingTag] = useState<TagDto | null>(null);
  const [creatingTag, setCreatingTag] = useState(false);
  const [deletingTag, setDeletingTag] = useState<TagDto | null>(null);

  const scopeOptions = optionsOf(tagScopeLabels);

  const toastError = (err: unknown, fallback: string) =>
    showToast(err instanceof ApiError ? err.message : fallback);

  const saveConfig = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (form.provider.trim() !== (aiConfig?.provider ?? "")) body.provider = form.provider.trim() || null;
      if (form.baseUrl.trim() !== (aiConfig?.baseUrl ?? "")) body.baseUrl = form.baseUrl.trim() || null;
      if (form.model.trim() !== (aiConfig?.model ?? "")) body.model = form.model.trim() || null;
      if (form.apiKey.trim() !== "") body.apiKey = form.apiKey.trim();
      await api.patch("/system/ai-config", body);
      setForm((f) => ({ ...f, apiKey: "" }));
      await queryClient.invalidateQueries({ queryKey: ["system", "ai-config"] });
      showToast("已保存 LLM 配置");
    } catch (err) {
      toastError(err, "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const loadConfigIntoForm = (cfg: AiConfigDto | undefined) => {
    if (!cfg) return;
    setForm((f) => ({ ...f, provider: cfg.provider ?? "", baseUrl: cfg.baseUrl ?? "", model: cfg.model ?? "" }));
  };

  // 配置加载/保存后自动预填（apiKey 保持空，不把掩码当输入值）
  useEffect(() => {
    if (aiConfig) {
      setForm((f) => ({
        ...f,
        provider: aiConfig.provider ?? "",
        baseUrl: aiConfig.baseUrl ?? "",
        model: aiConfig.model ?? "",
      }));
    }
  }, [aiConfig]);

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

  const canRead = useMemo(() => can(role, "system", "read"), [role]);
  if (!canRead) {
    return (
      <div className="page-head">
        <h1>系统设置</h1>
        <div className="task-empty">没有权限访问系统设置</div>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>系统设置</h1>
      </div>

      <div className="settings-section">
        <div className="card">
          <div className="card-head">
            <h2>LLM 打标配置</h2>
          </div>
          <div className="card-body">
            <form className="settings-form" onSubmit={(e) => void saveConfig(e)}>
              <label className="field">
                供应商（OpenAI 兼容）
                <input
                  autoComplete="off"
                  placeholder="如 deepseek / moonshot / ollama"
                  value={form.provider}
                  onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                />
              </label>
              <label className="field">
                Base URL
                <input
                  autoComplete="off"
                  placeholder="如 https://api.deepseek.com/v1"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                />
              </label>
              <label className="field">
                模型
                <input
                  autoComplete="off"
                  placeholder="如 deepseek-chat"
                  value={form.model}
                  onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                />
              </label>
              <label className="field">
                API Key
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={aiConfig?.apiKeySet ? `已配置（${aiConfig.apiKeyMasked}），留空则不改` : "未配置"}
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                />
              </label>
              <div className="modal-actions field-span">
                <button type="button" onClick={() => loadConfigIntoForm(aiConfig)} disabled={busy}>
                  还原
                </button>
                <button type="submit" className="btn-primary" disabled={busy}>
                  保存配置
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>标签词表</h2>
            {canManageTags && (
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
                      {canManageTags && (
                        <>
                          <button type="button" onClick={() => setEditingTag(t)}>
                            修改
                          </button>
                          <button type="button" className="btn-danger" onClick={() => setDeletingTag(t)}>
                            删除
                          </button>
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
