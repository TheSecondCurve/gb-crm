// 文案工作台（K60）：tab——「生成与审计」（六段维度提示词 + LLM 生成 + 逆向检查（第二轮审修）+
// 用户视角审计 + 行内保存）、「已保存文案」（搜索/分页/查看/编辑/删除）、「模板管理」（六维度词表卡片 CRUD）、
// 「提示词配置」（三类 system prompt 覆盖值，仅 admin）。
// 「选模板」是前端行为（把模板 content 填入输入框），generate/review/audit 只收最终文本快照。
// 三类 system prompt（生成/逆向检查/审计）的内置默认不可修改，覆盖配置在本页「提示词配置」tab（admin）。
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  can,
  copyAuditVerdictLabels,
  copyDimensionLabels,
  copyDimensionSchema,
  type CopyAuditReport,
  type CopyAuditVerdict,
  type CopyDimension,
  type ListEnvelope,
  type SystemRole,
} from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import type { CopyItemDto, CopyTemplateDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { formatDateTime } from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopywritingPromptsTab } from "../components/CopywritingPromptsTab";
import { Pagination } from "../components/DataGrid/DataGrid";
import { Modal } from "../components/Modal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";

const DIMENSIONS = copyDimensionSchema.options;

type DimensionTexts = Record<CopyDimension, string>;

const emptyTexts = (): DimensionTexts => ({
  background: "",
  audience: "",
  topic: "",
  goal: "",
  outputType: "",
  polish: "",
});

/** verdict badge 色：pass 绿 / warn 黄 / fail 红（token 板只有冷漆红，绿黄用内联贴近语义的暗色描边） */
const VERDICT_STYLES: Record<CopyAuditVerdict, CSSProperties> = {
  pass: { color: "#2e7d46", borderColor: "#2e7d46" },
  warn: { color: "#9a6a00", borderColor: "#9a6a00" },
  fail: { color: "var(--accent)", borderColor: "var(--accent)", fontWeight: 600 },
};

function VerdictBadge({ verdict }: { verdict: CopyAuditVerdict }) {
  return (
    <span className="badge" style={VERDICT_STYLES[verdict]}>
      {copyAuditVerdictLabels[verdict]}
    </span>
  );
}

/** 解析已保存文案的审计报告快照；非 JSON / 结构不符 → null（调用方按纯文本展示） */
function parseAuditReport(raw: string | null): CopyAuditReport | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CopyAuditReport;
    if (parsed && typeof parsed.verdict === "string" && Array.isArray(parsed.issues)) {
      return parsed;
    }
  } catch {
    // 按纯文本展示
  }
  return null;
}

/** 六段当前文本 → 提交体（trim 后非空才带键） */
function dimensionBody(texts: DimensionTexts): Record<string, string> {
  const body: Record<string, string> = {};
  for (const dim of DIMENSIONS) {
    const t = texts[dim].trim();
    if (t) body[dim] = t;
  }
  return body;
}

export function CopywritingPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  // 「提示词配置」是 system 配置（PATCH 仅 admin），只对 admin 显隐；其余角色固定三 tab
  const canManagePrompts = can(role, "system", "update");
  const tabKeys = ["generate", "saved", "templates", ...(canManagePrompts ? ["prompts"] : [])];
  const tab = tabKeys.includes(requestedTab ?? "") ? (requestedTab ?? "generate") : "generate";

  return (
    <>
      <div className="page-head">
        <h1>文案工作台</h1>
      </div>
      <div className="tabs" role="tablist" aria-label="文案工作台">
        <button type="button" role="tab" aria-selected={tab === "generate"} onClick={() => setSearchParams({ tab: "generate" })}>
          生成与审计
        </button>
        <button type="button" role="tab" aria-selected={tab === "saved"} onClick={() => setSearchParams({ tab: "saved" })}>
          已保存文案
        </button>
        <button type="button" role="tab" aria-selected={tab === "templates"} onClick={() => setSearchParams({ tab: "templates" })}>
          模板管理
        </button>
        {canManagePrompts && (
          <button type="button" role="tab" aria-selected={tab === "prompts"} onClick={() => setSearchParams({ tab: "prompts" })}>
            提示词配置
          </button>
        )}
      </div>
      {tab === "generate" && <GenerateTab canCreate={can(role, "copywriting", "create")} canManagePrompts={canManagePrompts} />}
      {tab === "saved" && <SavedTab role={role} />}
      {tab === "templates" && <TemplatesTab role={role} />}
      {tab === "prompts" && canManagePrompts && <CopywritingPromptsTab />}
    </>
  );
}

/** 生成结果：标题（LLM 产出、可编辑、保存必填）+ 正文（可编辑）；original = 逆向检查前的原始稿 */
interface GenResult {
  title: string;
  content: string;
  original: string | null;
}

/** Tab 1：生成与审计 */
function GenerateTab({ canCreate, canManagePrompts }: { canCreate: boolean; canManagePrompts: boolean }) {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [texts, setTexts] = useState<DimensionTexts>(emptyTexts);
  /** 每个维度当前选中的模板 id（"" = 自定义） */
  const [selected, setSelected] = useState<Record<CopyDimension, string>>({
    background: "",
    audience: "",
    topic: "",
    goal: "",
    outputType: "",
    polish: "",
  });
  const [autoReview, setAutoReview] = useState(true);
  const [result, setResult] = useState<GenResult | null>(null);
  const [report, setReport] = useState<CopyAuditReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: templates = [] } = useQuery({
    queryKey: ["copywriting", "templates", "enabled"],
    queryFn: async () =>
      (await api.get<{ data: CopyTemplateDto[] }>("/copywriting/templates?enabled=true"))?.data ?? [],
  });
  const byDimension = useMemo(() => {
    const map: Record<CopyDimension, CopyTemplateDto[]> = {
      background: [],
      audience: [],
      topic: [],
      goal: [],
      outputType: [],
      polish: [],
    };
    for (const t of templates) {
      if ((DIMENSIONS as readonly string[]).includes(t.dimension)) {
        map[t.dimension as CopyDimension].push(t);
      }
    }
    return map;
  }, [templates]);

  const toastError = (err: unknown, fallback: string) =>
    showToast(err instanceof ApiError ? err.message : fallback);

  const selectTemplate = (dim: CopyDimension, id: string) => {
    setSelected((s) => ({ ...s, [dim]: id }));
    // 选中模板 → 用模板正文覆盖输入框；切回自定义不动文本
    if (id === "") return;
    const tpl = byDimension[dim].find((t) => String(t.id) === id);
    if (tpl) setTexts((s) => ({ ...s, [dim]: tpl.content }));
  };

  const topicEmpty = texts.topic.trim() === "";

  /** 内容被编辑/重审后旧审计报告失效 */
  const touchResult = (next: GenResult) => {
    setResult(next);
    setReport(null);
  };

  const generate = async () => {
    if (topicEmpty) {
      showToast("请先填写主题内容");
      return;
    }
    setGenerating(true);
    const dims = dimensionBody(texts);
    try {
      const gen = await api.post<{ data: { title: string; content: string } }>("/copywriting/generate", {
        ...dims,
        topic: texts.topic.trim(),
      });
      const draft: GenResult = {
        title: gen?.data.title ?? "",
        content: gen?.data.content ?? "",
        original: null,
      };
      if (autoReview) {
        // 逆向检查：单独第二次 LLM 调用，修订稿才是产出；失败保留原始稿
        try {
          const rev = await api.post<{ data: { title: string; content: string } }>("/copywriting/review", {
            ...dims,
            title: draft.title,
            content: draft.content,
          });
          setResult({
            title: rev?.data.title || draft.title,
            content: rev?.data.content || draft.content,
            original: draft.content,
          });
          showToast("已生成并完成逆向检查修订");
        } catch (err) {
          setResult(draft);
          showToast(
            err instanceof ApiError ? `${err.message}（已保留原始稿）` : "逆向检查失败，已保留原始稿",
          );
        }
      } else {
        setResult(draft);
      }
      setReport(null);
    } catch (err) {
      toastError(err, "生成失败，请稍后重试");
    } finally {
      setGenerating(false);
    }
  };

  /** 手动对当前结果再跑一轮逆向检查修订 */
  const reviewNow = async () => {
    if (!result || reviewing) return;
    setReviewing(true);
    try {
      const rev = await api.post<{ data: { title: string; content: string } }>("/copywriting/review", {
        ...dimensionBody(texts),
        title: result.title,
        content: result.content,
      });
      touchResult({
        title: rev?.data.title || result.title,
        content: rev?.data.content || result.content,
        original: result.content,
      });
      showToast("已完成逆向检查修订");
    } catch (err) {
      toastError(err, "逆向检查失败，请稍后重试");
    } finally {
      setReviewing(false);
    }
  };

  const audit = async () => {
    if (!result) return;
    setAuditing(true);
    try {
      const res = await api.post<{ data: CopyAuditReport }>("/copywriting/audit", {
        ...dimensionBody(texts),
        content: result.content,
      });
      if (res?.data) setReport(res.data);
    } catch (err) {
      toastError(err, "审计失败，请稍后重试");
    } finally {
      setAuditing(false);
    }
  };

  const copyContent = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.content);
      showToast("已复制");
    } catch {
      showToast("复制失败，请手动选择文本复制");
    }
  };

  /** 行内保存：标题（保存必填，LLM 已预填）+ 当前正文 + 六段快照 + 审计快照 */
  const save = async () => {
    if (!result) return;
    const title = result.title.trim();
    if (!title) {
      showToast("请填写标题后再保存");
      return;
    }
    setSaving(true);
    try {
      await api.post("/copywriting/items", {
        title,
        ...dimensionBody(texts),
        content: result.content,
        auditReport: report ? JSON.stringify(report) : null,
      });
      showToast("已保存");
      void queryClient.invalidateQueries({ queryKey: ["copywriting", "items"] });
    } catch (err) {
      toastError(err, "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>提示词</h2>
          <span className="muted-text" style={{ fontSize: 12 }}>
            {canManagePrompts
              ? "生成/逆向检查/审计的 system prompt 内置默认不可修改，覆盖配置在本页「提示词配置」tab"
              : "生成/逆向检查/审计的 system prompt 由管理员统一维护（内置默认不可修改）"}
          </span>
        </div>
        {/* 六段维度纵向整行平铺（模板内容长也不挤压）；textarea 只允许纵向拉伸（CSS resize: vertical），防横向撑破错位 */}
        <div className="card-body copy-dims">
          {DIMENSIONS.map((dim) => (
            <div className="copy-dim" key={dim}>
              <div className="copy-dim-head">
                <span className="copy-dim-label">
                  {copyDimensionLabels[dim]}
                  {dim === "topic" && <span className="req-star">*</span>}
                </span>
                <select
                  aria-label={`${copyDimensionLabels[dim]}模板`}
                  value={selected[dim]}
                  onChange={(e) => selectTemplate(dim, e.target.value)}
                >
                  <option value="">自定义（不使用模板）</option>
                  {byDimension[dim].map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                aria-label={copyDimensionLabels[dim]}
                rows={dim === "topic" ? 4 : 2}
                value={texts[dim]}
                placeholder="本次自定义…"
                onChange={(e) => setTexts((s) => ({ ...s, [dim]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div
          className="card-body"
          style={{ paddingTop: 0, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}
        >
          <label className="inline-field">
            <input
              type="checkbox"
              aria-label="生成后自动逆向检查"
              checked={autoReview}
              onChange={(e) => setAutoReview(e.target.checked)}
            />
            生成后自动逆向检查（第二轮 LLM 审修）
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={generating || topicEmpty}
            title={topicEmpty ? "请先填写主题内容" : undefined}
            onClick={() => void generate()}
          >
            {generating ? "生成中…" : "生成文案"}
          </button>
        </div>
      </div>

      {result && (
        <div className="card">
          <div className="card-head">
            <h2>生成结果</h2>
            <div className="row-actions">
              <button type="button" disabled={reviewing || generating} onClick={() => void reviewNow()}>
                {reviewing ? "检查中…" : "逆向检查修订"}
              </button>
              <button type="button" disabled={auditing} onClick={() => void audit()}>
                {auditing ? "审计中…" : "AI 审计"}
              </button>
              <button type="button" onClick={() => void copyContent()}>
                复制
              </button>
              {canCreate && (
                <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>
                  {saving ? "保存中…" : "保存文案"}
                </button>
              )}
            </div>
          </div>
          <div className="card-body">
            {result.original !== null && (
              <p className="page-tip" style={{ marginTop: 0 }}>
                已完成逆向检查修订，以下为修订稿。
                <details style={{ marginTop: 8 }}>
                  <summary style={{ cursor: "pointer", display: "inline-block" }}>查看原始稿</summary>
                  <div className="material-content" style={{ marginTop: 8 }}>
                    {result.original}
                  </div>
                </details>
              </p>
            )}
            <label className="field">
              <span>
                标题<span className="req-star">*</span>
              </span>
              <input
                aria-label="文案标题"
                value={result.title}
                placeholder="LLM 生成，可修改；保存时必填"
                onChange={(e) => touchResult({ ...result, title: e.target.value })}
              />
            </label>
            <label className="field">
              <span>正文</span>
              <textarea
                aria-label="文案正文"
                rows={12}
                value={result.content}
                onChange={(e) => touchResult({ ...result, content: e.target.value })}
              />
            </label>
          </div>
          {report && (
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div className="card">
                <div className="card-head">
                  <h2>审计报告</h2>
                  <VerdictBadge verdict={report.verdict} />
                </div>
                <div className="card-body">
                  <p className="page-tip">{report.summary}</p>
                  {report.issues.length > 0 && (
                    <div className="task-list">
                      {report.issues.map((issue, i) => (
                        <div className="task-row" key={i} style={{ alignItems: "flex-start" }}>
                          <div>
                            <div style={{ fontWeight: 500 }}>{issue.aspect}</div>
                            <div className="task-meta" style={{ whiteSpace: "normal" }}>{issue.detail}</div>
                            <div className="task-meta" style={{ whiteSpace: "normal" }}>建议：{issue.suggestion}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Tab 2：已保存文案（q 搜索 + 分页 + 查看/编辑/删除） */
function SavedTab({ role }: { role: SystemRole | null }) {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<CopyItemDto | null>(null);
  const [editing, setEditing] = useState<CopyItemDto | null>(null);
  const [deleting, setDeleting] = useState<CopyItemDto | null>(null);

  const canUpdate = can(role, "copywriting", "update");
  const canDelete = can(role, "copywriting", "delete");

  const { data } = useQuery({
    queryKey: ["copywriting", "items", page, pageSize, q],
    queryFn: async () =>
      (await api.get<ListEnvelope<CopyItemDto>>(
        `/copywriting/items${buildQuery({ page, pageSize, q })}`,
      )) ?? { data: [], meta: { page, pageSize, total: 0 } },
  });
  const items = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["copywriting", "items"] });

  const saveEdit = async (title: string, content: string) => {
    if (!editing) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = { updatedAt: editing.updatedAt };
      if (title.trim() !== editing.title) body.title = title.trim();
      if (content !== editing.content) body.content = content;
      await api.patch(`/copywriting/items/${editing.id}`, body);
      setEditing(null);
      await invalidate();
      showToast("已保存");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showToast("该文案已被他人更新，请刷新后重试");
        setEditing(null);
        await invalidate();
      } else {
        showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/copywriting/items/${deleting.id}`);
      setDeleting(null);
      await invalidate();
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
        <div className="search-bar">
          <SearchBar
            onSearch={(value) => {
              setQ(value);
              setPage(1);
            }}
            placeholder="搜索文案…"
          />
        </div>
      </div>
      <div className="card">
        <div className="card-body-flush">
          {items.length === 0 ? (
            <div className="empty">暂无保存的文案</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>产出类型</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.title}</td>
                    <td>{item.outputType ?? "—"}</td>
                    <td>{formatDateTime(item.updatedAt)}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => setViewing(item)}>
                        查看
                      </button>
                      {canUpdate && (
                        <button type="button" onClick={() => setEditing(item)}>
                          编辑
                        </button>
                      )}
                      {canDelete && (
                        <button type="button" className="btn-danger" onClick={() => setDeleting(item)}>
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {total > 0 && (
          <div className="card-footer">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onChange={(p, ps) => {
                setPage(p);
                setPageSize(ps);
              }}
            />
          </div>
        )}
      </div>

      {viewing && <CopyViewModal item={viewing} onClose={() => setViewing(null)} />}
      {editing && (
        <CopyEditModal item={editing} busy={busy} onClose={() => setEditing(null)} onSubmit={saveEdit} />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除文案"
          message={`确定删除文案「${deleting.title}」吗？`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}

/** 「查看」弹窗：六段快照（只读）+ 正文 + 审计报告（parse 失败按纯文本展示） */
function CopyViewModal({ item, onClose }: { item: CopyItemDto; onClose: () => void }) {
  const report = parseAuditReport(item.auditReport);
  return (
    <Modal title={item.title} onClose={onClose} wide>
      {DIMENSIONS.map((dim) => (
        <div className="detail-row" key={dim}>
          <span className="detail-label">{copyDimensionLabels[dim]}</span>
          <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap" }}>{item[dim] ?? "—"}</span>
        </div>
      ))}
      <div className="detail-row">
        <span className="detail-label">正文</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <div className="material-content">{item.content}</div>
        </span>
      </div>
      <div className="detail-row">
        <span className="detail-label">审计报告</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {report ? (
            <>
              <VerdictBadge verdict={report.verdict} />
              <p className="page-tip">{report.summary}</p>
              {report.issues.map((issue, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 500 }}>{issue.aspect}</div>
                  <div className="muted-text">{issue.detail}</div>
                  <div className="muted-text">建议：{issue.suggestion}</div>
                </div>
              ))}
            </>
          ) : item.auditReport ? (
            <span style={{ whiteSpace: "pre-wrap" }}>{item.auditReport}</span>
          ) : (
            <span className="muted-text">—</span>
          )}
        </span>
      </div>
      <div className="detail-row">
        <span className="detail-label">更新时间</span>
        <span className="muted-text">{formatDateTime(item.updatedAt)}</span>
      </div>
    </Modal>
  );
}

interface CopyEditModalProps {
  item: CopyItemDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (title: string, content: string) => Promise<void>;
}

/** 「编辑」弹窗：改标题 + 正文（PATCH 带 updatedAt 行级 OCC） */
function CopyEditModal({ item, busy, onClose, onSubmit }: CopyEditModalProps) {
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  return (
    <Modal title={`编辑文案：${item.title}`} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit(title, content);
        }}
      >
        <label className="field">
          标题
          <input required value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          正文
          <textarea
            required
            rows={10}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Tab 3：模板管理（六维度词表卡片；无写权限整 tab 只读） */
function TemplatesTab({ role }: { role: SystemRole | null }) {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState<CopyDimension | null>(null);
  const [editing, setEditing] = useState<CopyTemplateDto | null>(null);
  const [deleting, setDeleting] = useState<CopyTemplateDto | null>(null);

  const canWrite =
    can(role, "copywriting", "create") &&
    can(role, "copywriting", "update") &&
    can(role, "copywriting", "delete");

  const { data: templates = [] } = useQuery({
    queryKey: ["copywriting", "templates", "all"],
    queryFn: async () =>
      (await api.get<{ data: CopyTemplateDto[] }>("/copywriting/templates"))?.data ?? [],
  });
  const byDimension = useMemo(() => {
    const map: Record<CopyDimension, CopyTemplateDto[]> = {
      background: [],
      audience: [],
      topic: [],
      goal: [],
      outputType: [],
      polish: [],
    };
    for (const t of templates) {
      if ((DIMENSIONS as readonly string[]).includes(t.dimension)) {
        map[t.dimension as CopyDimension].push(t);
      }
    }
    for (const dim of DIMENSIONS) {
      map[dim].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    }
    return map;
  }, [templates]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["copywriting", "templates"] });

  const submitTemplate = async (body: Record<string, unknown>, existing: CopyTemplateDto | null) => {
    setBusy(true);
    try {
      if (existing) {
        await api.patch(`/copywriting/templates/${existing.id}`, { ...body, updatedAt: existing.updatedAt });
      } else {
        await api.post("/copywriting/templates", body);
      }
      setCreating(null);
      setEditing(null);
      await invalidate();
      showToast("已保存模板");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存模板失败");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/copywriting/templates/${deleting.id}`);
      setDeleting(null);
      await invalidate();
      showToast("已删除模板");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {DIMENSIONS.map((dim) => (
        <div className="card" key={dim}>
          <div className="card-head">
            <h2>{copyDimensionLabels[dim]}</h2>
            {canWrite && (
              <button type="button" className="btn-primary" onClick={() => setCreating(dim)}>
                新增
              </button>
            )}
          </div>
          <div className="card-body-flush">
            {byDimension[dim].length === 0 ? (
              <div className="task-empty">暂无模板</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>正文预览</th>
                    <th>排序</th>
                    <th>状态</th>
                    {canWrite && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {byDimension[dim].map((t) => (
                    <tr key={t.id} className={t.enabled ? undefined : "row-disabled"}>
                      <td>
                        {t.name}
                        {!t.enabled && (
                          <>
                            {" "}
                            <span className="badge badge-muted">停用</span>
                          </>
                        )}
                      </td>
                      <td>
                        {t.content.length > 60 ? `${t.content.slice(0, 60)}…` : t.content}
                      </td>
                      <td>{t.sort}</td>
                      <td>{t.enabled ? "启用" : "停用"}</td>
                      {canWrite && (
                        <td className="row-actions">
                          <button type="button" onClick={() => setEditing(t)}>
                            编辑
                          </button>
                          <button type="button" className="btn-danger" onClick={() => setDeleting(t)}>
                            删除
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      ))}

      {(creating || editing) && (
        <TemplateFormModal
          title={creating ? `新增模板：${copyDimensionLabels[creating]}` : `编辑模板：${editing?.name}`}
          dimension={creating ?? (editing?.dimension as CopyDimension)}
          template={editing}
          busy={busy}
          onClose={() => {
            setCreating(null);
            setEditing(null);
          }}
          onSubmit={(body) => submitTemplate(body, editing)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除模板"
          message={`确定删除模板「${deleting.name}」吗？`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}

interface TemplateFormModalProps {
  title: string;
  dimension: CopyDimension;
  template: CopyTemplateDto | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

/** 新增/编辑共用模板表单：名称 + 正文 + 排序号 + 启用（编辑走 PATCH 键存在才 SET + updatedAt） */
function TemplateFormModal({ title, dimension, template, busy, onClose, onSubmit }: TemplateFormModalProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [content, setContent] = useState(template?.content ?? "");
  const [sort, setSort] = useState(String(template?.sort ?? 0));
  const [enabled, setEnabled] = useState(template?.enabled ?? true);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (template === null) body.dimension = dimension;
    if (template === null || template.name !== name.trim()) body.name = name.trim();
    if (template === null || template.content !== content.trim()) body.content = content.trim();
    const sortNum = Number(sort);
    if (Number.isFinite(sortNum) && (template === null || template.sort !== sortNum)) body.sort = sortNum;
    if (template === null || template.enabled !== enabled) body.enabled = enabled;
    await onSubmit(body);
  };

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <label className="field">
          名称
          <input required value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          正文
          <textarea required rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
        </label>
        <label className="field">
          排序号
          <input type="number" min={0} value={sort} onChange={(e) => setSort(e.target.value)} />
        </label>
        <label className="inline-field">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {template ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
