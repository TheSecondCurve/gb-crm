// 文案工作台「提示词配置」tab（K60+，仅 admin）：generate/audit/review 的 system prompt 维护。
// 未配置回退内置默认（customized=false）；「还原默认」PATCH null 即复位——配置改坏的安全绳。
// 维护入口在本页（文案工作台 → 提示词配置 tab），不在系统设置；六维度内容模板词表在「模板管理」tab。
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "../api/client";
import type { CopywritingPromptsDto } from "../api/types";
import { useToast } from "./Toast";

export function CopywritingPromptsTab() {
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
    <div className="settings-section">
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
    </div>
  );
}
