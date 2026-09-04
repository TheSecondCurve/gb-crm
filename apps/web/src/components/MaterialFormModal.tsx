// 新增/修改交付资料弹窗（K54 改造）：kind 下拉切换 content/url 显隐
//（文本类 content 可空——只是初稿，全文维护走 /materials/:id/edit 编辑页；媒体类 url 必填）。
// 交付单 / 客户关联统一用 EntityPicker（单选 / 多选；fixedDeliveryId 时锁定不显示）。
// 修改模式提交带 updatedAt（行级 OCC）；校验失败/409 由调用方 toast。
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { MATERIAL_FILE_KIND, MATERIAL_TEXT_KINDS, materialKindLabels } from "@gb-crm/shared";

import type { MaterialDetailDto } from "../api/types";
import { optionsOf } from "../columns/common";
import { customerLabelCache, customerOptionsLoader, deliveryLabelCache, deliveryOptionsLoader } from "../columns/relation";
import { EntityPicker } from "./EntityPicker";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface MaterialFormModalProps {
  title: string;
  /** 传 DetailDto = 修改模式（预填全字段 + OCC updatedAt）；缺席 = 新建 */
  material?: MaterialDetailDto;
  /** 交付单详情页内新增/修改：关联交付锁定为该单，表单不显示交付单选择 */
  fixedDeliveryId?: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>, file?: File) => Promise<void>;
}

export function MaterialFormModal({ title, material, fixedDeliveryId, busy, onClose, onSubmit }: MaterialFormModalProps) {
  const showToast = useToast();
  const navigate = useNavigate();
  const editing = material != null;

  // 编辑模式：把已有交付/客户 id→label 预填进缓存，EntityPicker chips 直接有名字
  if (material?.delivery && !deliveryLabelCache.has(material.delivery.id)) {
    const d = material.delivery;
    deliveryLabelCache.set(d.id, `${d.deliveryType?.name ?? "交付"} #${d.id}`);
  }
  for (const c of material?.customers ?? []) {
    if (!customerLabelCache.has(c.id)) customerLabelCache.set(c.id, c.nickname);
  }

  const [kind, setKind] = useState(material?.kind ?? "text");
  const [materialTitle, setMaterialTitle] = useState(material?.title ?? "");
  const [content, setContent] = useState(material?.content ?? "");
  const [url, setUrl] = useState(material?.url ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [deliveryId, setDeliveryId] = useState<number | null>(material?.deliveryId ?? null);
  const [selected, setSelected] = useState<number[]>(material ? material.customers.map((c) => c.id) : []);

  const textKind = (MATERIAL_TEXT_KINDS as readonly string[]).includes(kind);
  const fileKind = kind === MATERIAL_FILE_KIND;
  const lockDelivery = fixedDeliveryId !== undefined;
  const lockKind = editing && material.kind === MATERIAL_FILE_KIND;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!materialTitle.trim()) {
      showToast("请填写资料标题");
      return;
    }
    if (fileKind) {
      if (!editing && !file) {
        showToast("请选择要上传的文件");
        return;
      }
      void onSubmit(
        {
          ...(material ? { updatedAt: material.updatedAt } : {}),
          kind,
          title: materialTitle.trim(),
          deliveryId: lockDelivery ? fixedDeliveryId : deliveryId,
          customerIds: selected,
        },
        file ?? undefined,
      );
      return;
    }
    if (!textKind && !url.trim()) {
      showToast("媒体类资料必须填写链接");
      return;
    }
    void onSubmit({
      // PATCH 行级 OCC：修改模式必须带当前 updatedAt（新建模式缺席）
      ...(material ? { updatedAt: material.updatedAt } : {}),
      kind,
      title: materialTitle.trim(),
      // content/url 总是成对提交：非本类的一律 null 清空，避免 kind 切换后残留脏值
      content: textKind ? content : null,
      url: textKind ? null : url.trim(),
      deliveryId: lockDelivery ? fixedDeliveryId : deliveryId,
      customerIds: selected,
    });
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field">
          资料类型<span className="req-star">*</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={lockKind}>
            {optionsOf(materialKindLabels).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          标题<span className="req-star">*</span>
          <input autoComplete="off" value={materialTitle} onChange={(e) => setMaterialTitle(e.target.value)} />
        </label>
        {textKind ? (
          <label className="field field-span">
            内容（初稿，可选）
            <textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
            <span className="muted-text">可在创建后进入全文编辑器完善</span>
          </label>
        ) : fileKind ? (
          <label className="field field-span">
            文件{editing ? "" : <span className="req-star">*</span>}
            <input
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <span className="muted-text">
              {editing
                ? `当前：${material.originalFilename ?? "已上传"}；重新选择则替换（≤32MB）`
                : "上传到资料存储（≤32MB）。图片可在线预览，其他文件可下载。"}
            </span>
          </label>
        ) : (
          <label className="field field-span">
            链接<span className="req-star">*</span>
            <input autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </label>
        )}
        {!lockDelivery && (
          <div className="field field-span">
            关联交付单
            <EntityPicker
              loader={deliveryOptionsLoader}
              cache={deliveryLabelCache}
              selectedIds={deliveryId ? [deliveryId] : []}
              onChange={(ids) => setDeliveryId(ids[0] ?? null)}
              multiple={false}
              placeholder="搜索交付单…"
              ariaLabel="关联交付单"
            />
          </div>
        )}
        <div className="field field-span">
          关联客户（{selected.length} 人）
          <EntityPicker
            loader={customerOptionsLoader}
            cache={customerLabelCache}
            selectedIds={selected}
            onChange={setSelected}
            placeholder="搜索客户…"
            ariaLabel="搜索客户"
          />
        </div>
        <div className="modal-actions field-span">
          {editing && textKind && (
            <button type="button" onClick={() => navigate(`/materials/${material.id}/edit`)}>
              编辑全文内容 →
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {editing ? "保存" : "创建"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
