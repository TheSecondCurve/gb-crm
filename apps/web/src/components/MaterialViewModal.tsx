// 交付资料只读查看弹窗（K54）：标题 + kind 徽章 + 关联交付/客户 + 可点链接 + 完整 content（预格式化滚动区）。
// 调用方先 GET /materials/:id 拿 DetailDto 再打开。
import { materialKindLabels } from "@gb-crm/shared";

import type { MaterialDetailDto } from "../api/types";
import { badge, epochMsToDate, formatDateTime } from "../columns/common";
import { Modal } from "./Modal";

interface MaterialViewModalProps {
  material: MaterialDetailDto;
  onClose: () => void;
}

export function MaterialViewModal({ material, onClose }: MaterialViewModalProps) {
  const delivery = material.delivery;
  const deliveryLabel = delivery
    ? `${delivery.deliveryType?.name ?? "交付"} #${delivery.id}${
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
      {material.content !== null && (
        <div className="detail-row">
          <span className="detail-label">内容</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <div className="material-content">{material.content}</div>
          </span>
        </div>
      )}
      <div className="detail-row">
        <span className="detail-label">更新时间</span>
        <span className="muted-text">{formatDateTime(material.updatedAt)}</span>
      </div>
    </Modal>
  );
}
