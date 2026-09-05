// 资料专区（K54）：两个视图 tab——「浏览」= 普通 table（长文本不做行内编辑，行操作走 modal），
// 「文件专区」= kind=file 的 album 格子（MaterialFileAlbum）。
// 浏览筛选：按关联交付类型分组 tab（useResourceList secondaryFilterKey="deliveryKind"）+ q +
// kind 下拉（filterKey="kind"）+ 「仅看未关联」checkbox + K58 标签下拉（受控 state 拼进 fixedQuery，不改 hook）。
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  can,
  deliveryTypeKindLabels,
  MATERIAL_FILE_KIND,
  MATERIAL_TEXT_KINDS,
  materialKindLabels,
} from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import { formatFileSize, materialFileUrl, shouldOpenEditor, submitMaterial } from "../api/materials";
import type { MaterialDetailDto, MaterialDto, TagDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, epochMsToDate, formatDateTime, optionsOf, type BadgeTone } from "../columns/common";
import { Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { MaterialFileAlbum } from "../components/MaterialFileAlbum";
import { MaterialFormModal } from "../components/MaterialFormModal";
import { MaterialViewModal } from "../components/MaterialViewModal";
import { SearchBar } from "../components/SearchBar";
import { useToast } from "../components/Toast";
import { useResourceList } from "./useResourceList";

const KIND_TONES: Record<string, BadgeTone> = { transcript: "accent", file: "accent" };

/** 资料专区 tab：按关联交付类型分组。consulting/activity/circle 对应类型；other 兜底（未关联 + 类型为 other）。 */
const DELIVERY_KIND_TABS: { value: string; label: string }[] = [
  { value: "consulting", label: deliveryTypeKindLabels.consulting },
  { value: "activity", label: deliveryTypeKindLabels.activity },
  { value: "circle", label: deliveryTypeKindLabels.circle },
  { value: "other", label: "其他" },
];

/** 交付资料列表页（K54） */
export function MaterialsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const navigate = useNavigate();
  // orphan=1 / tagId 不在 hook 的 filterKey 体系内：受控 state → fixedQuery（并入 query 与 queryKey）
  const [orphanOnly, setOrphanOnly] = useState(false);
  const [tagId, setTagId] = useState("");
  const fixedQuery = useMemo(() => {
    const fq: Record<string, number> = {};
    if (orphanOnly) fq.orphan = 1;
    if (tagId) fq.tagId = Number(tagId);
    return Object.keys(fq).length > 0 ? fq : undefined;
  }, [orphanOnly, tagId]);
  const list = useResourceList<MaterialDto>("materials", "kind", fixedQuery, "deliveryKind");

  // K58：标签筛选下拉选项（资料域词表；加载失败静默降级为只有「全部标签」）
  const { data: tagOptions = [] } = useQuery({
    queryKey: ["tags", "material"],
    queryFn: async () =>
      (await api.get<{ data: TagDto[] }>("/tags?domain=material&pageSize=100"))?.data ?? [],
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MaterialDetailDto | null>(null);
  const [viewing, setViewing] = useState<MaterialDetailDto | null>(null);
  const [deleting, setDeleting] = useState<MaterialDto | null>(null);
  const [busy, setBusy] = useState(false);
  /** 页面视图：browse = 表格浏览（默认），files = 文件专区 album */
  const [view, setView] = useState<"browse" | "files">("browse");

  const canCreate = can(role, "materials", "create");
  const canUpdate = can(role, "materials", "update");
  const canDelete = can(role, "materials", "delete");

  // 查看 / 修改前先拉 DetailDto（列表 DTO 不含完整 content）
  const openDetail = async (id: number, apply: (m: MaterialDetailDto) => void) => {
    try {
      const res = await api.get<{ data: MaterialDetailDto }>(`/materials/${id}`);
      if (res?.data) apply(res.data);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "加载资料失败，请稍后重试");
    }
  };

  const saveMaterial = async (
    body: Record<string, unknown>,
    existing: MaterialDetailDto | null,
    file?: File,
  ) => {
    setBusy(true);
    try {
      const saved = await submitMaterial(body, file, existing);
      setCreating(false);
      setEditing(null);
      await list.invalidate();
      if (existing) {
        showToast("已保存");
      } else {
        showToast("已创建资料");
        if (saved && shouldOpenEditor(saved.kind)) navigate(`/materials/${saved.id}/edit`);
      }
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该行已被他人更新，请刷新后重试"
          : err instanceof Error
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
      await api.delete(`/materials/${deleting.id}`);
      setDeleting(null);
      await list.invalidate();
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
        <h1>资料专区</h1>
        <div className="search-bar">
          {view === "browse" && (
            <>
              <SearchBar onSearch={list.changeSearch} placeholder="搜索资料/交付名…" />
              <select aria-label="类型筛选" value={list.filter} onChange={(e) => list.changeFilter(e.target.value)}>
                <option value="">全部类型</option>
                {optionsOf(materialKindLabels).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select aria-label="标签筛选" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                <option value="">全部标签</option>
                {tagOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <label className="inline-field">
                <input
                  type="checkbox"
                  checked={orphanOnly}
                  onChange={(e) => setOrphanOnly(e.target.checked)}
                />
                仅看未关联
              </label>
            </>
          )}
          {canCreate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新增资料
            </button>
          )}
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="资料专区视图">
        <button type="button" role="tab" aria-selected={view === "browse"} onClick={() => setView("browse")}>
          浏览
        </button>
        <button type="button" role="tab" aria-selected={view === "files"} onClick={() => setView("files")}>
          文件专区
        </button>
      </div>
      {view === "files" ? (
        <MaterialFileAlbum
          canUpdate={canUpdate}
          canDelete={canDelete}
          onView={(id) => void openDetail(id, setViewing)}
          onEdit={(id) => void openDetail(id, setEditing)}
          onDelete={setDeleting}
        />
      ) : (
      <div className="card">
        <div className="tabs" role="tablist" aria-label="按关联交付类型筛选">
          <button
            type="button"
            role="tab"
            aria-selected={list.secondFilter === ""}
            onClick={() => list.changeSecondFilter("")}
          >
            全部
          </button>
          {DELIVERY_KIND_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={list.secondFilter === t.value}
              onClick={() => list.changeSecondFilter(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="card-body-flush">
          {list.rows.length === 0 && !list.loading && <div className="task-empty">暂无资料</div>}
          {(list.rows.length > 0 || list.loading) && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>关联交付</th>
                  <th>关联客户</th>
                  <th>标签</th>
                  <th>内容</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="badge-wrap">
                        {badge(materialKindLabels[row.kind as keyof typeof materialKindLabels] ?? row.kind, KIND_TONES[row.kind] ?? "plain")}
                      </span>{" "}
                      {row.title}
                    </td>
                    <td>
                      {row.delivery
                        ? `${row.delivery.name ?? row.delivery.deliveryType?.name ?? "交付"} ${
                            epochMsToDate(row.delivery.startsAt) || epochMsToDate(row.delivery.endsAt)
                              ? `（${epochMsToDate(row.delivery.startsAt) || "?"} ~ ${epochMsToDate(row.delivery.endsAt) || "?"}）`
                              : `#${row.delivery.id}`
                          }`
                        : "未关联"}
                    </td>
                    <td>
                      {row.customers.length === 0 && "未关联"}
                      {row.customers.map((c) => (
                        <span className="chip" key={c.id}>
                          {c.nickname}
                        </span>
                      ))}
                    </td>
                    <td>
                      {row.tags.length === 0 && "—"}
                      <span className="tag-list">
                        {row.tags.map((t) => (
                          <Fragment key={t.id}>{badge(t.name, "muted")}</Fragment>
                        ))}
                      </span>
                    </td>
                    <td>
                      {row.kind === MATERIAL_FILE_KIND
                        ? `${row.originalFilename ?? "文件"}${row.fileSize != null ? `（${formatFileSize(row.fileSize)}）` : ""}`
                        : row.excerpt
                          ? row.excerpt
                          : row.contentLength > 0
                            ? `${row.contentLength} 字符`
                            : "—"}
                    </td>
                    <td>{formatDateTime(row.updatedAt)}</td>
                    <td>
                      <span className="row-actions">
                        <button type="button" onClick={() => void openDetail(row.id, setViewing)}>
                          查看
                        </button>
                        {row.kind === MATERIAL_FILE_KIND && (
                          <a href={materialFileUrl(row.id, true)}>下载</a>
                        )}
                        {canUpdate && (MATERIAL_TEXT_KINDS as readonly string[]).includes(row.kind) && (
                          <button type="button" onClick={() => navigate(`/materials/${row.id}/edit`)}>
                            编辑内容
                          </button>
                        )}
                        {canUpdate && (
                          <button type="button" onClick={() => void openDetail(row.id, setEditing)}>
                            修改
                          </button>
                        )}
                        {canDelete && (
                          <button type="button" className="btn-danger" onClick={() => setDeleting(row)}>
                            删除
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card-footer">
          <Pagination page={list.page} pageSize={list.pageSize} total={list.total} onChange={list.changePage} />
        </div>
      </div>
      )}
      {creating && (
        <MaterialFormModal
          title="新增资料"
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(body, file) => saveMaterial(body, null, file)}
        />
      )}
      {editing && (
        <MaterialFormModal
          title={`修改资料：${editing.title}`}
          material={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={(body, file) => saveMaterial(body, editing, file)}
        />
      )}
      {viewing && <MaterialViewModal material={viewing} canUpdate={canUpdate} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmDialog
          title="删除资料"
          message={`确定删除资料「${deleting.title}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
