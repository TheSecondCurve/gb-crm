// 资料专区「文件专区」tab：kind=file 的资料按 album 格子展示（区别于「浏览」tab 的表格）。
// 图片直接渲染缩略图（GET /materials/:id/file 同源 cookie），其他类型按扩展名/ contentType 给图标占位；
// 卡片带标题 / 文件名·大小 / 更新时间 / 标签 + 查看/下载/修改/删除（权限收敛与列表页一致）。
// 过滤：q 搜索（服务端命中标题/全文/文件名/标签名）+ 交付名单选过滤（EntityPicker 按交付名定位）。
// 查询键以 "materials" 开头：列表页保存/删除后的 invalidateQueries(["materials"]) 会顺带刷新本 tab。
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
} from "@phosphor-icons/react";
import type { ListEnvelope } from "@gb-crm/shared";

import { api, buildQuery } from "../api/client";
import { formatFileSize, materialFileUrl } from "../api/materials";
import type { MaterialDto } from "../api/types";
import { badge, formatDateTime } from "../columns/common";
import { deliveryLabelCache, deliveryOptionsLoader } from "../columns/relation";
import { Pagination } from "./DataGrid/DataGrid";
import { EntityPicker } from "./EntityPicker";
import { SearchBar } from "./SearchBar";

type IconComponent = typeof FileIcon;

/** 非图片文件的占位图标：先看 contentType，再看扩展名 */
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

/** 占位图标下的扩展名标注（无扩展名用 contentType 子类型兜底） */
function extLabel(m: MaterialDto): string {
  const name = m.originalFilename ?? "";
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && dot < name.length - 1) return name.slice(dot + 1);
  return m.contentType?.split("/").pop() ?? "file";
}

interface MaterialFileAlbumProps {
  canUpdate: boolean;
  canDelete: boolean;
  onView: (id: number) => void;
  onEdit: (id: number) => void;
  onDelete: (m: MaterialDto) => void;
}

export function MaterialFileAlbum({ canUpdate, canDelete, onView, onEdit, onDelete }: MaterialFileAlbumProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [q, setQ] = useState("");
  /** 交付过滤（deliveryId 等值；EntityPicker 单选，× 即清空） */
  const [deliveryId, setDeliveryId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["materials", "file-album", page, pageSize, q, deliveryId],
    queryFn: async () =>
      (await api.get<ListEnvelope<MaterialDto>>(
        `/materials${buildQuery({ kind: "file", q, deliveryId: deliveryId ?? undefined, page, pageSize })}`,
      )) ?? { data: [], meta: { page, pageSize, total: 0 } },
  });
  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  return (
    <div className="card">
      <div className="album-toolbar">
        <SearchBar
          onSearch={(value) => {
            setQ(value);
            setPage(1);
          }}
          placeholder="搜索文件资料…"
        />
        <div className="album-delivery-filter">
          <EntityPicker
            loader={deliveryOptionsLoader}
            cache={deliveryLabelCache}
            selectedIds={deliveryId != null ? [deliveryId] : []}
            onChange={(ids) => {
              setDeliveryId(ids[0] ?? null);
              setPage(1);
            }}
            multiple={false}
            placeholder="按交付名定位交付单…"
            ariaLabel="按交付过滤"
          />
        </div>
      </div>
      {rows.length === 0 && !isLoading && <div className="task-empty">暂无文件资料</div>}
      {rows.length > 0 && (
        <div className="album-grid">
          {rows.map((m) => {
            const Icon = fileIcon(m);
            return (
              <div className="album-card" key={m.id}>
                <button
                  type="button"
                  className="album-thumb"
                  onClick={() => onView(m.id)}
                  aria-label={`查看 ${m.title}`}
                >
                  {m.isImage ? (
                    <img src={materialFileUrl(m.id)} alt={m.originalFilename ?? m.title} loading="lazy" />
                  ) : (
                    <span className="album-thumb-placeholder">
                      <Icon size={40} weight="duotone" aria-hidden />
                      <span className="album-ext">{extLabel(m)}</span>
                    </span>
                  )}
                </button>
                <div className="album-body">
                  <div className="album-title" title={m.title}>
                    {m.title}
                  </div>
                  <div className="album-meta" title={m.originalFilename ?? undefined}>
                    {m.originalFilename ?? "文件"}
                    {m.fileSize != null ? ` · ${formatFileSize(m.fileSize)}` : ""}
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
                  <a href={materialFileUrl(m.id, true)}>下载</a>
                  <button type="button" onClick={() => onView(m.id)}>
                    查看
                  </button>
                  {canUpdate && (
                    <button type="button" onClick={() => onEdit(m.id)}>
                      修改
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="btn-danger" onClick={() => onDelete(m)}>
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
          onChange={(nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          }}
        />
      </div>
    </div>
  );
}
