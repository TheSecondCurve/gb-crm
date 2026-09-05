// 交付资料只读查看弹窗（K54 改造）：标题 + kind 徽章 + 关联交付/客户 + 可点链接 + Markdown 渲染的完整 content。
// 调用方先 GET /materials/:id 拿 DetailDto 再打开；canUpdate + 文本类时底部给「编辑全文」入口。
import { Fragment } from "react";
import { useNavigate } from "react-router-dom";
import { MATERIAL_FILE_KIND, MATERIAL_TEXT_KINDS, materialKindLabels } from "@gb-crm/shared";

import { formatFileSize, materialFileUrl } from "../api/materials";
import type { MaterialDetailDto } from "../api/types";
import { badge, epochMsToDate, formatDateTime } from "../columns/common";
import { MarkdownView } from "./MarkdownView";
import { Modal } from "./Modal";

interface MaterialViewModalProps {
  material: MaterialDetailDto;
  /** 有 materials.update 权限时文本类资料显示「编辑全文」按钮 */
  canUpdate?: boolean;
  onClose: () => void;
}

export function MaterialViewModal({ material, canUpdate = false, onClose }: MaterialViewModalProps) {
  const navigate = useNavigate();
  const delivery = material.delivery;
  const deliveryLabel = delivery
    ? `${delivery.name ?? delivery.deliveryType?.name ?? "交付"} #${delivery.id}${
        delivery.startsAt || delivery.endsAt
          ? `（${epochMsToDate(delivery.startsAt) || "?"} ~ ${epochMsToDate(delivery.endsAt) || "?"}）`
          : ""
      }`
    : null;

  return (
    <Modal title={material.title} onClose={onClose} wide>
      <div className="detail-row">
        <span className="detail-label">类型</span>
        <span>{badge(materialKindLabels[material.kind as keyof typeof materialKindLabels] ?? material.kind)}</span>
      </div>
      <div className="detail-row">
        <span className="detail-label">关联交付</span>
        <span>{deliveryLabel ?? "未关联"}</span>
      </div>
      <div className="detail-row">
        <span className="detail-label">关联客户</span>
        <span className="detail-chips">
          {material.customers.length === 0 && <span className="muted-text">未关联</span>}
          {material.customers.map((c) => (
            <span className="chip" key={c.id}>
              {c.nickname}
            </span>
          ))}
        </span>
      </div>
      <div className="detail-row">
        <span className="detail-label">标签</span>
        <span className="detail-chips">
          {material.tags.length === 0 && <span className="muted-text">—</span>}
          {material.tags.map((t) => (
            <Fragment key={t.id}>{badge(t.name, "muted")}</Fragment>
          ))}
        </span>
      </div>
      {material.url && (
        <div className="detail-row">
          <span className="detail-label">链接</span>
          <span>
            <a href={material.url} target="_blank" rel="noreferrer">
              {material.url}
            </a>
          </span>
        </div>
      )}
      {material.kind === MATERIAL_FILE_KIND && (
        <div className="detail-row">
          <span className="detail-label">文件</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div>
              {material.originalFilename ?? "文件"}
              {material.fileSize != null ? ` · ${formatFileSize(material.fileSize)}` : ""}
            </div>
            {material.isImage && (
              <img
                className="material-file-preview"
                src={materialFileUrl(material.id)}
                alt={material.originalFilename ?? material.title}
              />
            )}
            <div className="row-actions" style={{ marginTop: 8 }}>
              <a href={materialFileUrl(material.id, true)}>下载</a>
            </div>
          </span>
        </div>
      )}
      {material.content !== null && (
        <div className="detail-row">
          <span className="detail-label">内容</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <MarkdownView source={material.content} className="material-content" />
          </span>
        </div>
      )}
      <div className="detail-row">
        <span className="detail-label">更新时间</span>
        <span className="muted-text">{formatDateTime(material.updatedAt)}</span>
      </div>
      {canUpdate && (MATERIAL_TEXT_KINDS as readonly string[]).includes(material.kind) && (
        <div className="modal-actions">
          <button type="button" onClick={() => navigate(`/materials/${material.id}/edit`)}>
            编辑全文
          </button>
        </div>
      )}
    </Modal>
  );
}
