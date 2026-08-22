import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, deliverableDimensionLabels } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type { DeliverableDto, DeliveryDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, optionsOf, type BadgeTone } from "../columns/common";
import { customerOptionsLoader } from "../columns/relation";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeliveryFormModal } from "../components/DeliveryFormModal";
import { ItemModal } from "../components/ItemModal";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

const DIM_TONES: Record<string, BadgeTone> = { customer: "accent" };

/** 交付单详情页：信息卡（类型/备注/客户 chips）+ 交付项列表 + 动作打勾（K44） */
export function DeliveryDetailPage() {
  const { id } = useParams();
  const deliveryId = Number(id);
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const navigate = useNavigate();

  const canUpdate = can(role, "deliveries", "update");
  const canDelete = can(role, "deliveries", "delete");

  const { data: delivery, refetch: refetchDelivery } = useQuery({
    queryKey: ["deliveries", deliveryId],
    queryFn: async () => (await api.get<{ data: DeliveryDto }>(`/deliveries/${deliveryId}`))?.data,
  });
  const { data: items, refetch: refetchItems } = useQuery({
    queryKey: ["deliveries", deliveryId, "items"],
    queryFn: async () =>
      (await api.get<{ data: DeliverableDto[] }>(`/deliveries/${deliveryId}/items`))?.data ?? [],
  });

  const [creatingItem, setCreatingItem] = useState(false);
  const [editingItem, setEditingItem] = useState<DeliverableDto | null>(null);
  const [deletingItem, setDeletingItem] = useState<DeliverableDto | null>(null);
  const [itemsOf, setItemsOf] = useState<DeliverableDto | null>(null);
  const [editingDelivery, setEditingDelivery] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    await Promise.all([refetchDelivery(), refetchItems()]);
  }, [refetchDelivery, refetchItems]);

  const totalProgress = useMemo(() => {
    const list = items ?? [];
    const done = list.reduce((acc, it) => acc + it.tasks.filter((t) => t.done).length, 0);
    const total = list.reduce((acc, it) => acc + it.tasks.length, 0);
    return { done, total };
  }, [items]);

  const createItem = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post(`/deliveries/${deliveryId}/items`, body);
      setCreatingItem(false);
      await refresh();
      showToast("已创建交付项");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const updateItem = async (body: Record<string, unknown>) => {
    if (!editingItem) return;
    setBusy(true);
    try {
      await api.patch(`/deliveries/${deliveryId}/items/${editingItem.id}`, body);
      setEditingItem(null);
      await refresh();
      showToast("已保存");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteItem = async () => {
    if (!deletingItem) return;
    setBusy(true);
    try {
      await api.delete(`/deliveries/${deliveryId}/items/${deletingItem.id}`);
      setDeletingItem(null);
      await refresh();
      showToast("已删除");
    } finally {
      setBusy(false);
    }
  };

  const saveDelivery = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.patch(`/deliveries/${deliveryId}`, body);
      setEditingDelivery(false);
      await refresh();
      showToast("已保存");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  if (!delivery) {
    return <div className="page-loading">加载中…</div>;
  }

  return (
    <>
      <div className="page-head">
        <h1>{delivery.deliveryType?.name ?? `交付 #${delivery.id}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate("/deliveries")}>
            返回列表
          </button>
          {canUpdate && (
            <button type="button" className="btn-primary" onClick={() => setEditingDelivery(true)}>
              修改交付
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="detail-row">
            <span className="detail-label">交付类型</span>
            <span>{delivery.deliveryType?.name ?? "—"}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">客户（{delivery.customers.length} 人）</span>
            <span className="detail-chips">
              {delivery.customers.map((c) => (
                <span className="chip" key={c.id}>
                  {c.nickname}
                </span>
              ))}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">备注</span>
            <span>{delivery.remark || "—"}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">动作进度</span>
            <span>
              {totalProgress.total > 0 ? (
                badge(`${totalProgress.done}/${totalProgress.total}`, totalProgress.done === totalProgress.total ? "accent" : "plain")
              ) : (
                "—"
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>交付项</h2>
          {canUpdate && (
            <button type="button" className="btn-primary" onClick={() => setCreatingItem(true)}>
              新增交付项
            </button>
          )}
        </div>
        <div className="card-body-flush">
          {items && items.length === 0 && <div className="task-empty">暂无交付项</div>}
          {items?.map((item) => {
            const done = item.tasks.filter((t) => t.done).length;
            const customerCovered = item.dimension === "customer"
              ? new Set(item.tasks.map((t) => t.customer?.id).filter((v): v is number => v != null)).size
              : 0;
            return (
              <div className="item-row" key={item.id}>
                <div className="item-main">
                  <div className="item-title">
                    {item.content}
                    <span className="badge-wrap">
                      {badge(deliverableDimensionLabels[item.dimension as keyof typeof deliverableDimensionLabels] ?? item.dimension, DIM_TONES[item.dimension])}
                    </span>
                  </div>
                  <div className="item-meta">
                    {item.dimension === "customer"
                      ? `${customerCovered}/${delivery.customers.length} 客户已覆盖 · 打勾 ${done}/${item.tasks.length}`
                      : `打勾 ${done}/${item.tasks.length}`}
                    {item.description ? ` · ${item.description}` : ""}
                  </div>
                </div>
                <div className="row-actions">
                  <button type="button" onClick={() => setItemsOf(item)}>
                    动作
                  </button>
                  {canUpdate && (
                    <button type="button" onClick={() => setEditingItem(item)}>
                      修改
                    </button>
                  )}
                  {canDelete && (
                    <button type="button" className="btn-danger" onClick={() => setDeletingItem(item)}>
                      删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {creatingItem && delivery && (
        <ItemFormModal
          title="新增交付项"
          dimensionOptions={optionsOf(deliverableDimensionLabels)}
          customers={delivery.customers.map((c) => ({ id: c.id, nickname: c.nickname }))}
          busy={busy}
          onClose={() => setCreatingItem(false)}
          onSubmit={createItem}
        />
      )}
      {editingItem && (
        <Modal title={`修改交付项：${editingItem.content}`} onClose={() => setEditingItem(null)}>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const body: Record<string, unknown> = {
                content: (e.currentTarget.elements.namedItem("content") as HTMLInputElement).value.trim(),
                description: (e.currentTarget.elements.namedItem("description") as HTMLInputElement).value.trim() || null,
                deliveryUrl: (e.currentTarget.elements.namedItem("deliveryUrl") as HTMLInputElement).value.trim() || null,
                updatedAt: editingItem.updatedAt,
              };
              void updateItem(body);
            }}
          >
            <label className="field">
              标题
              <input name="content" defaultValue={editingItem.content} />
            </label>
            <label className="field field-span">
              交付说明
              <textarea name="description" rows={2} defaultValue={editingItem.description ?? ""} />
            </label>
            <label className="field field-span">
              交付物链接
              <input name="deliveryUrl" defaultValue={editingItem.deliveryUrl ?? ""} />
            </label>
            <div className="modal-actions field-span">
              <button type="button" onClick={() => setEditingItem(null)} disabled={busy}>
                取消
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                保存
              </button>
            </div>
          </form>
        </Modal>
      )}
      {itemsOf && (
        <ItemModal deliveryId={deliveryId} item={itemsOf} onClose={() => setItemsOf(null)} onChange={refresh} />
      )}
      {deletingItem && (
        <ConfirmDialog
          title="删除交付项"
          message={`确定删除交付项「${deletingItem.content}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDeleteItem()}
          onCancel={() => setDeletingItem(null)}
        />
      )}
      {editingDelivery && delivery && (
        <DeliveryFormModal
          title="修改交付"
          delivery={delivery}
          busy={busy}
          onClose={() => setEditingDelivery(false)}
          onSubmit={saveDelivery}
        />
      )}
    </>
  );
}

interface ItemFormModalProps {
  title: string;
  dimensionOptions: { value: string; label: string }[];
  customers: { id: number; nickname: string }[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

/** 新增交付项：标题 + 维度单选；客户维度时选择覆盖客户（默认全选） */
function ItemFormModal({ title, dimensionOptions, customers, busy, onClose, onSubmit }: ItemFormModalProps) {
  const showToast = useToast();
  const [dimension, setDimension] = useState("project");
  const [selected, setSelected] = useState<number[]>(customers.map((c) => c.id));
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState(customers);
  const [content, setContent] = useState("");
  const [description, setDescription] = useState("");
  const [deliveryUrl, setDeliveryUrl] = useState("");

  const doSearch = (q: string) => {
    setSearch(q);
    void customerOptionsLoader(q).then((list) => setOptions(list.map((o) => ({ id: o.id, nickname: o.label }))));
  };

  return (
    <Modal title={title} onClose={onClose} form>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (!content.trim()) {
            showToast("请填写交付项标题");
            return;
          }
          void onSubmit({
            content: content.trim(),
            dimension,
            // 全选 = 省略 customerIds（服务端视为全部客户）；部分选择才显式传
            customerIds:
              dimension === "customer"
                ? selected.length === customers.length
                  ? undefined
                  : selected
                : undefined,
            description: description.trim() || null,
            deliveryUrl: deliveryUrl.trim() || null,
          });
        }}
      >
        <label className="field">
          交付项标题
          <input autoComplete="off" value={content} onChange={(e) => setContent(e.target.value)} placeholder="如：拉群 / 圈子全年交付" />
        </label>
        <label className="field">
          维度
          <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
            {dimensionOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {dimension === "customer" && (
          <div className="field field-span">
            覆盖客户（{selected.length}/{customers.length}）
            <div className="form-picker">
              <input placeholder="搜索客户…" autoComplete="off" value={search} onChange={(e) => doSearch(e.target.value)} />
              <div className="form-checks">
                {options.map((c) => (
                  <label className="inline-field" key={c.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={() =>
                        setSelected((prev) =>
                          prev.includes(c.id) ? prev.filter((v) => v !== c.id) : [...prev, c.id],
                        )
                      }
                    />
                    {c.nickname}
                  </label>
                ))}
              </div>
              {search === "" && (
                <button type="button" onClick={() => setSelected(customers.map((c) => c.id))}>
                  全选
                </button>
              )}
            </div>
          </div>
        )}
        <label className="field field-span">
          交付说明
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field field-span">
          交付物链接
          <input autoComplete="off" value={deliveryUrl} onChange={(e) => setDeliveryUrl(e.target.value)} />
        </label>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}
