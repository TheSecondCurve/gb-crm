// 文案工作台「提示词配置」tab（K60+/K60++，仅 admin）：两类配置——
// 1) 三类 system prompt（generate/audit/review 覆盖值）：未配置回退内置默认（customized=false）；
//    「还原默认」PATCH null 即复位——配置改坏的安全绳。
// 2) 文案专用 LLM（code='copywritingLlm'）：完整时 copywriting 三端点优先走这里，否则回退系统 code='llm'；
//    apiKey 只回掩码（空输入保留旧值），「测试连接」用表单现值探测（不必先保存），「保存配置」PATCH 变更键。
// 六维度内容模板词表在「模板管理」tab。
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../api/client";
import type { CopywritingLlmDto, CopywritingPromptsDto } from "../api/types";
import { useToast } from "./Toast";

export function CopywritingPromptsTab() {
  return (
    <div className="settings-section">
      <PromptsCard />
      <CopywritingLlmCard />
    </div>
  );
}

// ---- 三类 system prompt ----

function PromptsCard() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ generate: "", audit: "", review: "" });

  const { data: prompts } = useQuery({
    queryKey: ["system", "copywriting-prompts"],
    queryFn: async () =>
      (await api.get<{ data: CopywritingPromptsDto }>("/system/copywriting-prompts"))?.data,
  });

  // 加载/保存后预填生效值（即配置 ?? 内置默认）
  useEffect(() => {
    if (prompts) {
      setForm({
        generate: prompts.generateSystemPrompt,
        audit: prompts.auditSystemPrompt,
        review: prompts.reviewSystemPrompt,
      });
    }
  }, [prompts]);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (form.generate !== prompts?.generateSystemPrompt) {
        body.generateSystemPrompt = form.generate.trim() || null; // 清空 = 恢复默认
      }
      if (form.audit !== prompts?.auditSystemPrompt) {
        body.auditSystemPrompt = form.audit.trim() || null;
      }
      if (form.review !== prompts?.reviewSystemPrompt) {
        body.reviewSystemPrompt = form.review.trim() || null;
      }
      await api.patch("/system/copywriting-prompts", body);
      await queryClient.invalidateQueries({ queryKey: ["system", "copywriting-prompts"] });
      showToast("已保存文案工作台提示词");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const restoreDefaults = async () => {
    setBusy(true);
    try {
      await api.patch("/system/copywriting-prompts", {
        generateSystemPrompt: null,
        auditSystemPrompt: null,
        reviewSystemPrompt: null,
      });
      await queryClient.invalidateQueries({ queryKey: ["system", "copywriting-prompts"] });
      showToast("已恢复内置默认提示词");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "还原失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>文案工作台提示词</h2>
        <span className={prompts?.customized ? "badge" : "muted"}>
          {prompts?.customized ? "已自定义" : "使用内置默认"}
        </span>
      </div>
      <div className="card-body">
        <p className="muted">
          生成、逆向检查与审计文案时发给模型的 system prompt（内置默认不可修改，此处为覆盖值）。
          留空保存即恢复内置默认；六维度内容模板词表在「模板管理」tab。
        </p>
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <label className="field">
            生成文案 system prompt
            <textarea
              rows={10}
              value={form.generate}
              onChange={(e) => setForm((f) => ({ ...f, generate: e.target.value }))}
            />
          </label>
          <label className="field">
            逆向检查 system prompt
            <textarea
              rows={10}
              value={form.review}
              onChange={(e) => setForm((f) => ({ ...f, review: e.target.value }))}
            />
          </label>
          <label className="field">
            审计 system prompt
            <textarea
              rows={10}
              value={form.audit}
              onChange={(e) => setForm((f) => ({ ...f, audit: e.target.value }))}
            />
          </label>
          <div className="modal-actions field-span">
            <button type="button" onClick={() => void restoreDefaults()} disabled={busy}>
              还原默认
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              保存配置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- 文案专用 LLM ----

function CopywritingLlmCard() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ provider: "", baseUrl: "", model: "", apiKey: "" });

  const { data: llm } = useQuery({
    queryKey: ["system", "copywriting-llm"],
    queryFn: async () =>
      (await api.get<{ data: CopywritingLlmDto }>("/system/copywriting-llm"))?.data,
  });

  // 加载后预填（apiKey 不回显，只给 placeholder 掩码提示）
  useEffect(() => {
    if (llm) {
      setForm({
        provider: llm.provider ?? "",
        baseUrl: llm.baseUrl ?? "",
        model: llm.model ?? "",
        apiKey: "",
      });
    }
  }, [llm]);

  /** 表单现值 → 覆盖体：仅带非空值（apiKey 只在重新输入时带） */
  const overrideBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    const provider = form.provider.trim();
    const baseUrl = form.baseUrl.trim();
    const model = form.model.trim();
    if (provider) body.provider = provider;
    if (baseUrl) body.baseUrl = baseUrl;
    if (model) body.model = model;
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
    return body;
  };

  const test = async () => {
    setBusy(true);
    try {
      await api.post("/system/copywriting-llm/test", overrideBody());
      showToast("连接成功：文案生成/逆向检查/审计将使用此配置");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "测试失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      const provider = form.provider.trim();
      const baseUrl = form.baseUrl.trim();
      const model = form.model.trim();
      // 与已保存值不同才发；清空字段 → null（可撤掉专用配置）
      if (provider !== (llm?.provider ?? "")) body.provider = provider || null;
      if (baseUrl !== (llm?.baseUrl ?? "")) body.baseUrl = baseUrl || null;
      if (model !== (llm?.model ?? "")) body.model = model || null;
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim(); // 空 = 保留旧 key
      await api.patch("/system/copywriting-llm", body);
      await queryClient.invalidateQueries({ queryKey: ["system", "copywriting-llm"] });
      setForm((f) => ({ ...f, apiKey: "" }));
      showToast("已保存文案专用 LLM 配置");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>文案专用 LLM（可选）</h2>
        <span className={llm?.dedicatedReady ? "badge" : "muted"}>
          {llm?.dedicatedReady ? "已启用：文案调用走此配置" : "未启用：沿用系统 LLM 配置"}
        </span>
      </div>
      <div className="card-body">
        <p className="muted">
          配置完整（Base URL / 模型 / API Key）后，生成、逆向检查与审计优先使用此连接；
          留空即回退「系统设置 → LLM 打标配置」。API Key 保存后不再回显，留空表示保留旧值。
        </p>
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <label className="field">
            服务商（展示用，如 deepseek / qwen）
            <input
              value={form.provider}
              placeholder="如 deepseek"
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            />
          </label>
          <label className="field">
            Base URL
            <input
              value={form.baseUrl}
              placeholder="如 https://api.deepseek.com/v1"
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            />
          </label>
          <label className="field">
            模型
            <input
              value={form.model}
              placeholder="如 deepseek-chat"
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            />
          </label>
          <label className="field">
            API Key
            <input
              type="password"
              value={form.apiKey}
              placeholder={llm?.apiKeyMasked ? `已保存 ${llm.apiKeyMasked}，留空保留` : "sk-…"}
              autoComplete="new-password"
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            />
          </label>
          <div className="modal-actions field-span">
            <button type="button" onClick={() => void test()} disabled={busy}>
              测试连接
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              保存配置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
