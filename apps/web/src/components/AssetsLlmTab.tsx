// 系统设置「素材识别」tab（K63）：素材图片 AI 识别的 vision LLM 配置。
// 语义同文案专用 LLM（K60++）：专用配置（assetsLlm）完整时识别走这里，否则回退系统 LLM；
// GET 掩码；PATCH apiKey 空串/缺席保留旧值、留空其他字段不覆盖；测试连接支持未保存表单值探测。
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../api/client";
import type { AssetsLlmDto } from "../api/types";
import { useToast } from "./Toast";

export function AssetsLlmTab() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState({ provider: "", baseUrl: "", model: "", apiKey: "" });

  const { data: cfg } = useQuery({
    queryKey: ["system", "assets-llm"],
    queryFn: async () => (await api.get<{ data: AssetsLlmDto }>("/system/assets-llm-config"))?.data,
  });

  useEffect(() => {
    if (!cfg) return;
    setForm({
      provider: cfg.provider ?? "",
      baseUrl: cfg.baseUrl ?? "",
      model: cfg.model ?? "",
      apiKey: cfg.apiKeySet ? "（已保存，留空不修改）" : "",
    });
  }, [cfg]);

  const overrideBody = () => ({
    provider: form.provider.trim() || null,
    baseUrl: form.baseUrl.trim() || null,
    model: form.model.trim() || null,
    // 「（已保存，留空不修改）」占位串 = 缺席语义；真实输入才提交
    apiKey: form.apiKey === "" || form.apiKey === "（已保存，留空不修改）" ? undefined : form.apiKey.trim(),
  });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch("/system/assets-llm-config", overrideBody());
      await queryClient.invalidateQueries({ queryKey: ["system", "assets-llm"] });
      showToast("已保存素材识别 LLM 配置");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await api.post("/system/assets-llm-config/test", overrideBody());
      showToast("连接成功");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "测试失败，请稍后重试");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="settings-section">
      <div className="card">
        <div className="card-head">素材识别 LLM（需支持图片输入的 vision 模型）</div>
        <div className="card-body">
          <p className="muted-text">
            素材库上传图片后自动 AI 识别（生成描述 / 打标签 / 建议归档）。完整配置后识别走这里；
            留空则回退「LLM 打标配置」的系统 LLM（要求该模型支持图片输入）。都未配置时上传不受影响，仅跳过识别。
            {cfg && (
              <strong>
                {" "}
                当前状态：{cfg.dedicatedReady ? "专用配置已就绪" : cfg.apiKeySet || cfg.baseUrl ? "专用配置不完整，回退系统 LLM" : "未配置专用 LLM"}
              </strong>
            )}
          </p>
          <form className="form-grid" onSubmit={save}>
            <label className="field">
              供应商
              <input
                autoComplete="off"
                value={form.provider}
                onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                placeholder="如 openai-compat"
              />
            </label>
            <label className="field">
              Base URL
              <input
                autoComplete="off"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://…/v1"
              />
            </label>
            <label className="field">
              模型（需 vision）
              <input
                autoComplete="off"
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="如 glm-4.6v / gpt-4o / qwen-vl-max"
              />
            </label>
            <label className="field">
              API Key
              <input
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            </label>
            <div className="modal-actions field-span">
              <button type="button" onClick={() => void test()} disabled={testing}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                保存
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
