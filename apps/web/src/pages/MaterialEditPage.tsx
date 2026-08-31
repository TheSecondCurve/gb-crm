// 资料全文编辑页（K54 改造）：/materials/:id/edit。全屏编辑器（非弹窗）：
// 顶栏 = 返回 + 标题/kind 徽章 + 编辑元信息（MaterialFormModal）+ 模式切换（编辑/分屏/预览）+ 保存（dirty 才可用）。
// 保存 = PATCH { content, updatedAt }（行级 OCC；409 提示不覆盖本地草稿）；Ctrl/Cmd+S 快捷保存；
// dirty 时 beforeunload + 返回二次确认。assistant（无 materials.update）强制只读预览。
// 媒体类 kind（audio/video/link）无正文，显示提示不渲染编辑器。
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "@phosphor-icons/react";
import { can, materialKindLabels } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type { MaterialDetailDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge } from "../columns/common";
import { MarkdownView } from "../components/MarkdownView";
import { MaterialFormModal } from "../components/MaterialFormModal";
import { useToast } from "../components/Toast";

const TEXT_KINDS: readonly string[] = ["transcript", "text"];

type EditorMode = "edit" | "split" | "preview";

const MODES: { value: EditorMode; label: string }[] = [
  { value: "edit", label: "编辑" },
  { value: "split", label: "分屏" },
  { value: "preview", label: "预览" },
];

export function MaterialEditPage() {
  const { id } = useParams();
  const materialId = Number(id);
  const navigate = useNavigate();
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const canUpdate = can(role, "materials", "update");

  const [material, setMaterial] = useState<MaterialDetailDto | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<EditorMode>("edit");
  const [metaOpen, setMetaOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // 拉 DetailDto（列表 DTO 不含完整 content）
  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ data: MaterialDetailDto }>(`/materials/${materialId}`)
      .then((res) => {
        if (cancelled || !res?.data) return;
        setMaterial(res.data);
        setDraft(res.data.content ?? "");
        setUpdatedAt(res.data.updatedAt);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const save = useCallback(async () => {
    if (!material || !dirty || saving) return;
    setSaving(true);
    try {
      const res = await api.patch<{ data: MaterialDetailDto }>(`/materials/${material.id}`, {
        content: draft,
        updatedAt,
      });
      if (res?.data) {
        setMaterial(res.data);
        setUpdatedAt(res.data.updatedAt);
      }
      setDirty(false);
      showToast("已保存");
    } catch (err) {
      // 409 不覆盖本地草稿，用户自行决定刷新/复制
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该行已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "保存失败，请稍后重试",
      );
    } finally {
      setSaving(false);
    }
  }, [material, dirty, saving, draft, updatedAt, showToast]);

  // Ctrl/Cmd+S 快捷保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // dirty 时关页/刷新提示
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const goBack = () => {
    if (dirty && !window.confirm("有未保存的修改，确定离开吗？")) return;
    // 无站内历史（直接打开链接）时退化到资料专区
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate("/materials");
  };

  // 元信息弹窗保存：用返回的 DetailDto 刷新 updatedAt；本地无未保存改动时才同步草稿（防覆盖）
  const saveMeta = async (body: Record<string, unknown>) => {
    if (!material) return;
    try {
      const res = await api.patch<{ data: MaterialDetailDto }>(`/materials/${material.id}`, body);
      if (res?.data) {
        setMaterial(res.data);
        setUpdatedAt(res.data.updatedAt);
        if (!dirty) setDraft(res.data.content ?? "");
      }
      setMetaOpen(false);
      showToast("已保存");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该行已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "保存失败，请稍后重试",
      );
    }
  };

  if (loadFailed) {
    return (
      <div className="page-loading" role="alert">
        加载资料失败，请稍后重试
      </div>
    );
  }
  if (!material) {
    return <div className="page-loading">加载中…</div>;
  }

  const textKind = TEXT_KINDS.includes(material.kind);

  // 媒体类：无正文内容，不渲染编辑器
  if (!textKind) {
    return (
      <>
        <div className="page-head">
          <h1>{material.title}</h1>
          <div className="search-bar">
            <button type="button" onClick={goBack}>
              返回
            </button>
          </div>
        </div>
        <div className="card">
          <div className="card-body-flush">
            <div className="task-empty">
              该资料为媒体类，无正文内容。
              {material.url && (
                <>
                  {" "}
                  <a href={material.url} target="_blank" rel="noreferrer">
                    打开链接
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      </>
    );
  }

  const effectiveMode: EditorMode = canUpdate ? mode : "preview";

  return (
    <div className="material-editor">
      <div className="page-head material-editor-bar">
        <h1>
          <span className="badge-wrap">
            {badge(materialKindLabels[material.kind as keyof typeof materialKindLabels] ?? material.kind)}
          </span>{" "}
          {material.title}
        </h1>
        <div className="search-bar">
          <button type="button" onClick={goBack}>
            <ArrowLeft weight="bold" aria-hidden /> 返回
          </button>
          {canUpdate && (
            <button type="button" onClick={() => setMetaOpen(true)}>
              编辑元信息
            </button>
          )}
          {canUpdate && (
            <div className="tabs material-editor-modes" role="group" aria-label="编辑模式">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  aria-pressed={effectiveMode === m.value}
                  onClick={() => setMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {canUpdate && (
            <button
              type="button"
              className="btn-primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          )}
        </div>
      </div>
      <div className={`material-editor-body mode-${effectiveMode}`}>
        {effectiveMode !== "preview" && (
          <textarea
            className="material-editor-input"
            aria-label="正文内容"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
          />
        )}
        {effectiveMode !== "edit" && (
          <MarkdownView source={draft} className="material-editor-preview" />
        )}
      </div>
      {metaOpen && (
        <MaterialFormModal
          title={`修改资料：${material.title}`}
          material={material}
          busy={saving}
          onClose={() => setMetaOpen(false)}
          onSubmit={saveMeta}
        />
      )}
    </div>
  );
}
