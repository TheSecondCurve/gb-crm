// 系统设置页（K46/K50/K51）：tab 结构（URL query 驱动，?tab=llm|jobs）。
// 「LLM 打标配置」（仅 admin，存储为 system_configs code='llm'）+「后台任务」（K51 运维查看/取消，全角色）。
// 标签词表在「业务设置」页（/business-settings，K50）。
// 路由守卫：仅登录即可访问；LLM tab 按 can(system, read) 显隐；侧栏入口同样按角色显隐。
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can } from "@gb-crm/shared";
import { useSearchParams } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type { AiConfigDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { JobsTab } from "../components/JobsTab";
import { useToast } from "../components/Toast";

export function SettingsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  // LLM tab 仅 admin；其余（jobs/缺失/越权）→ jobs。非 admin 固定 jobs。
  const canSystem = can(role, "system", "read");
  const tab = canSystem ? (requestedTab === "jobs" ? "jobs" : "llm") : "jobs";

  const { data: aiConfig } = useQuery({
    queryKey: ["system", "ai-config"],
    queryFn: async () =>
      (await api.get<{ data: AiConfigDto }>("/system/ai-config"))?.data,
    enabled: canSystem,
  });

  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ provider: "", baseUrl: "", model: "", apiKey: "" });

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

  return (
    <>
      <div className="page-head">
        <h1>系统设置</h1>
      </div>

      <div className="tabs" role="tablist" aria-label="系统设置">
        {canSystem && (
          <button type="button" role="tab" aria-selected={tab === "llm"} onClick={() => setSearchParams({ tab: "llm" })}>
            LLM 打标配置
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "jobs"} onClick={() => setSearchParams({ tab: "jobs" })}>
          后台任务
        </button>
      </div>

      {tab === "jobs" ? (
        <JobsTab />
      ) : (
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
        </div>
      )}
    </>
  );
}
