// 新增/修改交付资料弹窗（K54 改造）：kind 下拉切换 content/url 显隐
//（文本类 content 可空——只是初稿，全文维护走 /materials/:id/edit 编辑页；媒体类 url 必填）。
// 交付单 / 客户关联统一用 EntityPicker（单选 / 多选；fixedDeliveryId 时锁定不显示）。
// K58：资料标签 = 词表 chips 选择 + newTagNames 随手建词（新词虚线 chip 区分）；动过标签区才提交
// tagIds/newTagNames 两键（tagIds 整表替换、[] 清空），新建模式无选择时省略。
// 修改模式提交带 updatedAt（行级 OCC）；校验失败/409 由调用方 toast。
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { X } from "@phosphor-icons/react";
import { MATERIAL_FILE_KIND, MATERIAL_TEXT_KINDS, materialKindLabels } from "@gb-crm/shared";

import { api } from "../api/client";
import type { MaterialDetailDto, TagDto } from "../api/types";
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

/** K58：资料标签名归一（前后端 trim 语义的前端兜底：去首尾空白 + 大小写不敏感判重） */
const normTagName = (s: string) => s.trim().toLowerCase();

const MAX_NEW_TAGS = 10;

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

  // K58 资料标签：已选词表词（编辑模式用 material.tags 预填）+ 待建新词
  const [selectedTags, setSelectedTags] = useState<{ id: number; name: string }[]>(material?.tags ?? []);
  const [newTagNames, setNewTagNames] = useState<string[]>([]);
  const [tagTouched, setTagTouched] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const tagRef = useRef<HTMLDivElement>(null);

  // 资料域词表（加载失败静默降级：只剩手输新词可用）
  const { data: tagOptions = [] } = useQuery({
    queryKey: ["tags", "material"],
    queryFn: async () =>
      (await api.get<{ data: TagDto[] }>("/tags?domain=material&pageSize=100"))?.data ?? [],
  });

  // 点击标签区外收起候选下拉
  useEffect(() => {
    if (!tagOpen) return;
    const onDown = (e: MouseEvent) => {
      if (tagRef.current && !tagRef.current.contains(e.target as Node)) setTagOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [tagOpen]);

  // 候选 = 未选、且不与待建新词同名、且匹配搜索串的词表词
  const tagCandidates = tagOptions.filter(
    (t) =>
      !selectedTags.some((s) => s.id === t.id) &&
      !newTagNames.some((n) => normTagName(n) === normTagName(t.name)) &&
      (tagSearch.trim() === "" || t.name.includes(tagSearch.trim())),
  );

  const addExistingTag = (tag: TagDto) => {
    setSelectedTags((prev) => [...prev, { id: tag.id, name: tag.name }]);
    setTagTouched(true);
    setTagSearch("");
  };

  // 回车/失焦前的「添加」：词表有同名（归一后）直接复用，否则进 newTagNames
  const addTagFromInput = () => {
    const name = tagSearch.trim();
    if (!name) return;
    if (name.length > 50) {
      showToast("标签名最长 50 字");
      return;
    }
    const existing = tagOptions.find((t) => normTagName(t.name) === normTagName(name));
    if (existing) {
      if (!selectedTags.some((s) => s.id === existing.id)) addExistingTag(existing);
      else setTagSearch("");
      return;
    }
    if (selectedTags.some((s) => normTagName(s.name) === normTagName(name))) {
      setTagSearch("");
      return;
    }
    if (newTagNames.some((n) => normTagName(n) === normTagName(name))) {
      setTagSearch("");
      return;
    }
    if (newTagNames.length >= MAX_NEW_TAGS) {
      showToast(`新标签最多 ${MAX_NEW_TAGS} 个`);
      return;
    }
    setNewTagNames((prev) => [...prev, name]);
    setTagTouched(true);
    setTagSearch("");
  };

  const removeExistingTag = (id: number) => {
    setSelectedTags((prev) => prev.filter((t) => t.id !== id));
    setTagTouched(true);
  };
  const removeNewTag = (name: string) => {
    setNewTagNames((prev) => prev.filter((n) => n !== name));
    setTagTouched(true);
  };

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
    // K58：动过标签区才提交两键（tagIds 整表替换、[] 清空）；新建无选择可省略
    const tagBody: Record<string, unknown> = tagTouched
      ? { tagIds: selectedTags.map((t) => t.id), newTagNames }
      : {};
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
          ...tagBody,
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
      ...tagBody,
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
        <div className="field field-span">
          资料标签
          <div className="entity-picker" ref={tagRef}>
            {(selectedTags.length > 0 || newTagNames.length > 0) && (
              <div className="entity-picker-chips">
                {selectedTags.map((t) => (
                  <span className="chip" key={t.id}>
                    {t.name}
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`移除 ${t.name}`}
                      onClick={() => removeExistingTag(t.id)}
                    >
                      <X weight="bold" aria-hidden />
                    </button>
                  </span>
                ))}
                {newTagNames.map((n) => (
                  <span className="chip chip-new" key={n}>
                    {n}
                    <span className="chip-new-flag">新</span>
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`移除 ${n}`}
                      onClick={() => removeNewTag(n)}
                    >
                      <X weight="bold" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="entity-picker-box">
              <input
                type="search"
                autoComplete="off"
                placeholder="搜索词表，或输入新词后回车添加"
                aria-label="搜索资料标签"
                value={tagSearch}
                onFocus={() => setTagOpen(true)}
                onChange={(e) => {
                  setTagSearch(e.target.value);
                  setTagOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    // 表单内回车默认会提交整单，这里拦下转为「添加标签」
                    e.preventDefault();
                    addTagFromInput();
                  } else if (e.key === "Escape" && tagOpen) {
                    e.preventDefault();
                    e.stopPropagation();
                    setTagOpen(false);
                  }
                }}
              />
              {tagOpen && (
                <ul className="entity-picker-list" role="listbox">
                  {tagCandidates.length === 0 && <li className="entity-picker-empty">无匹配词，回车添加为新标签</li>}
                  {tagCandidates.map((t) => (
                    <li
                      key={t.id}
                      role="option"
                      aria-selected={false}
                      className="entity-picker-option"
                      // mousedown 先于 input blur，保证点击能选中
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addExistingTag(t);
                      }}
                    >
                      {t.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <span className="muted-text">词表中没有的词会自动创建为资料标签（最多 {MAX_NEW_TAGS} 个）</span>
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
