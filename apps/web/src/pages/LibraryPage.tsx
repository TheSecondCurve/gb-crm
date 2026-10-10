// 素材库（K63）：kind=file 的图片/文件主入口——左侧文件夹树（全部/未分类/live 文件夹，
// path 排序 + 缩进表达层级）+ 相册格子（缩略图/描述首行/尺寸徽标/AI 状态角标/标签）。
// 工具条：q 搜索 + 标签 chips 多选（tagNames AND）+ 多文件上传（逐个串行，duplicateOfId 软提示）。
// 多选批量：移入文件夹（PATCH folderId per 行，OCC）；加标签（newTagNames 并集通道）。
// 文件夹管理：树底内联新建（父=当前选中）；选中节点可重命名/删除（仅空可删，409 由 toast 呈现）。
// AI：失败/跳过的图片可单卡「重跑识别」（POST /materials/:id/enrich）。
import { Fragment, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  File as FileIcon,
  FileAudio,
  FileDoc,
  FileImage,
  FilePdf,
  FilePpt,
  FileText,
  FileVideo,
  FileXls,
  FileZip,
  SpinnerGap,
  Sparkle,
  WarningCircle,
  CheckCircle,
  MinusCircle,
} from "@phosphor-icons/react";
import { can, materialAiStatusLabels, type ListEnvelope } from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import { formatFileSize, materialFileUrl, uploadAsset } from "../api/materials";
import { createFolder, deleteFolder, FOLDERS_KEY, listFolders, patchFolder, rerunEnrich } from "../api/folders";
import type { MaterialDetailDto, MaterialDto, TagDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, formatDateTime } from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MaterialFormModal } from "../components/MaterialFormModal";
import { MaterialViewModal } from "../components/MaterialViewModal";
import { Pagination } from "../components/DataGrid/DataGrid";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";

type IconComponent = typeof FileIcon;

function fileIcon(m: MaterialDto): IconComponent {
  const ct = m.contentType ?? "";
  const ext = (m.originalFilename?.split(".").pop() ?? "").toLowerCase();
  if (ct.startsWith("audio/")) return FileAudio;
  if (ct.startsWith("video/")) return FileVideo;
  if (ct.startsWith("image/")) return FileImage;
  if (ct === "application/pdf" || ext === "pdf") return FilePdf;
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return FileZip;
  if (["doc", "docx"].includes(ext)) return FileDoc;
  if (["xls", "xlsx", "csv"].includes(ext)) return FileXls;
  if (["ppt", "pptx", "key"].includes(ext)) return FilePpt;
  if (ct.startsWith("text/") || ["txt", "md"].includes(ext)) return FileText;
  return FileIcon;
}

const AI_TONES: Record<string, { icon: IconComponent }> = {
  pending: { icon: SpinnerGap },
  ready: { icon: CheckCircle },
  failed: { icon: WarningCircle },
  skipped: { icon: MinusCircle },
};

export function LibraryPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const queryClient = useQueryClient();

  /** "all" = 全部；0 = 未分类；正数 = folderId */
  const [folder, setFolder] = useState<"all" | number>("all");
  const [q, setQ] = useState("");
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<number[]>([]);
  const [viewing, setViewing] = useState<MaterialDetailDto | null>(null);
  const [editing, setEditing] = useState<MaterialDetailDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<MaterialDto | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<number | null>(null);
  const [folderInput, setFolderInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canCreate = can(role, "materials", "create");
  const canUpdate = can(role, "materials", "update");
  const canDelete = can(role, "materials", "delete");

  const { data: folders = [] } = useQuery({
    queryKey: FOLDERS_KEY,
    queryFn: listFolders,
  });
  const { data: tagOptions = [] } = useQuery({
    queryKey: ["tags", "material"],
    queryFn: async () =>
      (await api.get<{ data: TagDto[] }>("/tags?domain=material&pageSize=100"))?.data ?? [],
  });

  const listQuery: Record<string, string | number | boolean | null | undefined> = {
    kind: "file",
    q,
    folderId: folder === "all" ? undefined : folder,
    tagNames: tagNames.length > 0 ? tagNames.join(",") : undefined,
    page,
    pageSize,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["materials", "library", listQuery],
    queryFn: async () =>
      (await api.get<ListEnvelope<MaterialDto>>(
        `/materials${buildQuery(listQuery)}`,
      )) ?? { data: [], meta: { page, pageSize, total: 0 } },
  });
  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["materials"] });
    await queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
  };

  const selectedRows = rows.filter((r) => selected.includes(r.id));

  const changeFolder = (next: "all" | number) => {
    setFolder(next);
    setPage(1);
    setSelected([]);
  };
  const toggleTag = (name: string) => {
    setTagNames((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]));
    setPage(1);
  };

  // ── 上传（多文件串行；失败继续，逐个 toast 汇总在最后） ──
  const onFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    let ok = 0;
    let dup = 0;
    let failed = 0;
    for (const file of Array.from(files)) {
      const title = file.name.replace(/\.[^.]+$/, "") || file.name;
      try {
        const res = await uploadAsset(file, {
          title,
          folderId: typeof folder === "number" && folder > 0 ? folder : undefined,
        });
        ok += 1;
        if (res.duplicateOfId != null) dup += 1;
      } catch {
        failed += 1;
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await refresh();
    const parts = [`成功上传 ${ok} 个`];
    if (dup > 0) parts.push(`${dup} 个与已有素材内容重复（已保留）`);
    if (failed > 0) parts.push(`${failed} 个失败`);
    showToast(parts.join("，"));
  };

  // ── 批量：移入文件夹 / 加标签（逐行 PATCH，OCC） ──
  const batchMove = async (target: "uncategorized" | number) => {
    if (selectedRows.length === 0) return;
    let failed = 0;
    for (const row of selectedRows) {
      try {
        await api.patch(`/materials/${row.id}`, {
          updatedAt: row.updatedAt,
          folderId: target === "uncategorized" ? null : target,
        });
      } catch {
        failed += 1;
      }
    }
    setSelected([]);
    await refresh();
    showToast(failed === 0 ? "已移动" : `已移动，${failed} 个失败（可能被他人修改，请刷新重试）`);
  };

  const batchAddTag = async (name: string) => {
    if (!name.trim() || selectedRows.length === 0) return;
    let failed = 0;
    for (const row of selectedRows) {
      try {
        await api.patch(`/materials/${row.id}`, {
          updatedAt: row.updatedAt,
          newTagNames: [name.trim()],
        });
      } catch {
        failed += 1;
      }
    }
    setSelected([]);
    await refresh();
    showToast(failed === 0 ? `已给 ${selectedRows.length} 个素材加标签「${name.trim()}」` : "部分失败，请刷新重试");
  };

  const onEnrich = async (id: number) => {
    try {
      await rerunEnrich(id);
      showToast("已重新排队识别");
      await refresh();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "重跑失败，请稍后重试");
    }
  };

  // ── 文件夹管理 ──
  const submitFolder = async () => {
    const name = folderInput.trim();
    if (!name) return;
    try {
      if (typeof folder === "number" && folder > 0) {
        // 选中了具体文件夹：输入框当「重命名」用；否则新建在根
        const target = folders.find((f) => f.id === folder);
        if (target) {
          await patchFolder(target.id, { name, updatedAt: target.updatedAt });
          showToast("已重命名");
        } else {
          await createFolder(name, null);
          showToast("已创建文件夹");
        }
      } else {
        await createFolder(name, null);
        showToast("已创建文件夹");
      }
      setFolderInput("");
      await queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "操作失败，请稍后重试");
    }
  };

  const confirmDeleteFolder = async () => {
    if (deletingFolder === null) return;
    try {
      await deleteFolder(deletingFolder);
      if (folder === deletingFolder) changeFolder("all");
      showToast("已删除文件夹");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setDeletingFolder(null);
      await queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
    }
  };

  const openDetail = async (id: number, apply: (m: MaterialDetailDto) => void) => {
    try {
      const res = await api.get<{ data: MaterialDetailDto }>(`/materials/${id}`);
      if (res?.data) apply(res.data);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "加载素材失败，请稍后重试");
    }
  };

  const saveMaterial = async (body: Record<string, unknown>, file?: File) => {
    if (!editing) return;
    try {
      // 复用 submitMaterial 的 file-kind 分支（替换文件 + PATCH 元数据）
      const { submitMaterial } = await import("../api/materials");
      const saved = await submitMaterial(body, file, editing);
      if (saved) showToast("已保存");
      setEditing(null);
      await refresh();
    } catch (err) {
      showToast(err instanceof ApiError && err.status === 409 ? "该行已被他人更新，请刷新后重试" : "保存失败，请稍后重试");
    }
  };

  const currentFolder = typeof folder === "number" && folder > 0 ? folders.find((f) => f.id === folder) : undefined;
  const moveTargets = [{ value: "uncategorized", label: "未分类" }, ...folders.map((f) => ({ value: String(f.id), label: f.path }))];

  return (
    <>
      <div className="page-head">
        <h1>素材库</h1>
        <div className="search-bar">
          <SearchBar
            onSearch={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="搜索标题/描述/标签/文件名…"
          />
          {canCreate && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => void onFilesPicked(e.target.files)}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? "上传中…" : "上传图片"}
              </button>
              <button type="button" onClick={() => setCreating(true)}>
                新增素材
              </button>
            </>
          )}
        </div>
      </div>

      {tagOptions.length > 0 && (
        <div className="lib-tag-filter" aria-label="标签筛选">
          {tagOptions.slice(0, 30).map((t) => {
            const active = tagNames.includes(t.name);
            return (
              <button
                key={t.id}
                type="button"
                className={active ? "chip chip-active" : "chip chip-clickable"}
                aria-pressed={active}
                onClick={() => toggleTag(t.name)}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="library-layout">
        <aside className="library-tree card">
          <button
            type="button"
            className={folder === "all" ? "library-tree-item active" : "library-tree-item"}
            onClick={() => changeFolder("all")}
          >
            全部素材（{total}）
          </button>
          <button
            type="button"
            className={folder === 0 ? "library-tree-item active" : "library-tree-item"}
            onClick={() => changeFolder(0)}
          >
            未分类
          </button>
          {folders.map((f) => {
            const depth = f.path.split("/").length - 1;
            return (
              <button
                key={f.id}
                type="button"
                className={folder === f.id ? "library-tree-item active" : "library-tree-item"}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => changeFolder(f.id)}
                title={f.path}
              >
                {f.name}（{f.materialCount}）
              </button>
            );
          })}
          {canCreate && (
            <div className="library-tree-manage">
              <input
                aria-label="文件夹名称"
                placeholder={currentFolder ? `重命名「${currentFolder.name}」…` : "新文件夹名称…"}
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitFolder();
                }}
              />
              <button type="button" onClick={() => void submitFolder()}>
                {currentFolder ? "重命名" : "新建"}
              </button>
              {canDelete && currentFolder && (
                <button type="button" className="btn-danger" onClick={() => setDeletingFolder(currentFolder.id)}>
                  删除
                </button>
              )}
            </div>
          )}
        </aside>

        <div className="library-main">
          {selected.length > 0 && canUpdate && (
            <div className="lib-batch-bar" role="toolbar" aria-label="批量操作">
              <span>已选 {selected.length} 项</span>
              <select
                aria-label="移入文件夹"
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") return;
                  void batchMove(v === "uncategorized" ? "uncategorized" : Number(v));
                  e.target.value = "";
                }}
              >
                <option value="">移入文件夹…</option>
                {moveTargets.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="批量加标签"
                placeholder="加标签（回车确认）"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = (e.target as HTMLInputElement).value;
                    if (v.trim()) void batchAddTag(v);
                    (e.target as HTMLInputElement).value = "";
                  }
                }}
              />
              <button type="button" onClick={() => setSelected([])}>
                取消选择
              </button>
            </div>
          )}
          <div className="card">
            {rows.length === 0 && !isLoading && <div className="task-empty">暂无素材</div>}
            {rows.length > 0 && (
              <div className="album-grid">
                {rows.map((m) => {
                  const Icon = fileIcon(m);
                  const ai = m.aiStatus ? AI_TONES[m.aiStatus] : undefined;
                  const AiIcon = ai?.icon;
                  const checked = selected.includes(m.id);
                  return (
                    <div className={checked ? "album-card selected" : "album-card"} key={m.id}>
                      <button
                        type="button"
                        className="album-thumb"
                        onClick={() => void openDetail(m.id, setViewing)}
                        aria-label={`查看 ${m.title}`}
                      >
                        {m.isImage ? (
                          <img src={materialFileUrl(m.id)} alt={m.originalFilename ?? m.title} loading="lazy" />
                        ) : (
                          <span className="album-thumb-placeholder">
                            <Icon size={40} weight="duotone" aria-hidden />
                          </span>
                        )}
                      </button>
                      {canUpdate && (
                        <label className="lib-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelected((prev) =>
                                prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                              )
                            }
                          />
                          选择
                        </label>
                      )}
                      <div className="album-body">
                        <div className="album-title" title={m.title}>
                          {m.title}
                        </div>
                        {m.description && (
                          <div className="album-meta lib-desc" title={m.description}>
                            {m.description}
                          </div>
                        )}
                        <div className="album-meta">
                          {m.imageWidth != null && m.imageHeight != null && (
                            <Fragment>
                              <span className="lib-dims">
                                {m.imageWidth}×{m.imageHeight}
                              </span>{" "}
                            </Fragment>
                          )}
                          {formatFileSize(m.fileSize)}
                          {m.folder ? ` · ${m.folder.path}` : ""}
                        </div>
                        <div className="album-meta">{formatDateTime(m.updatedAt)}</div>
                        {m.tags.length > 0 && (
                          <div className="album-tags">
                            {m.tags.map((t) => (
                              <Fragment key={t.id}>{badge(t.name, "muted")}</Fragment>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="album-actions">
                        {ai && AiIcon && (
                          <span className="lib-ai" title={`AI 识别：${materialAiStatusLabels[m.aiStatus as keyof typeof materialAiStatusLabels] ?? m.aiStatus}`}>
                            <AiIcon size={14} weight="bold" aria-hidden />
                            {materialAiStatusLabels[m.aiStatus as keyof typeof materialAiStatusLabels] ?? m.aiStatus}
                          </span>
                        )}
                        <a href={materialFileUrl(m.id, true)}>下载</a>
                        <button type="button" onClick={() => void openDetail(m.id, setViewing)}>
                          查看
                        </button>
                        {canUpdate && (m.aiStatus === "failed" || m.aiStatus === "skipped") && m.isImage && (
                          <button type="button" onClick={() => void onEnrich(m.id)}>
                            <Sparkle size={14} weight="bold" aria-hidden /> 重跑识别
                          </button>
                        )}
                        {canUpdate && (
                          <button type="button" onClick={() => void openDetail(m.id, setEditing)}>
                            修改
                          </button>
                        )}
                        {canDelete && (
                          <button type="button" className="btn-danger" onClick={() => setDeleting(m)}>
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
          </div>
        </div>
      </div>

      {creating && (
        <MaterialFormModal
          title="新增素材"
          defaultKind="file"
          defaultFolderId={typeof folder === "number" && folder > 0 ? folder : undefined}
          busy={false}
          onClose={() => setCreating(false)}
          onSubmit={async (body, file) => {
            try {
              const { submitMaterial } = await import("../api/materials");
              await submitMaterial(body, file, null);
              showToast("已创建素材");
              setCreating(false);
              await refresh();
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
            }
          }}
        />
      )}
      {editing && (
        <MaterialFormModal
          title={`修改素材：${editing.title}`}
          material={editing}
          busy={false}
          onClose={() => setEditing(null)}
          onSubmit={saveMaterial}
        />
      )}
      {viewing && <MaterialViewModal material={viewing} canUpdate={canUpdate} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="删除素材"
          message={`确定删除素材「${deleting.title}」吗？删除后不在列表显示。`}
          confirmText="删除"
          onConfirm={async () => {
            try {
              await api.delete(`/materials/${deleting.id}`);
              setDeleting(null);
              await refresh();
              showToast("已删除");
            } catch (err) {
              showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
            }
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
      {deletingFolder !== null && (
        <ConfirmDialog
          title="删除文件夹"
          message="仅空文件夹可删除（无直接素材、无子文件夹）。确定删除吗？"
          confirmText="删除"
          onConfirm={() => void confirmDeleteFolder()}
          onCancel={() => setDeletingFolder(null)}
        />
      )}
    </>
  );
}
