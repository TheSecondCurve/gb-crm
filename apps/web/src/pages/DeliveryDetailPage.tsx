import { Fragment, useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, deliverableDimensionLabels, MATERIAL_FILE_KIND, materialKindLabels } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError, buildQuery } from "../api/client";
import { materialFileUrl, shouldOpenEditor, submitMaterial } from "../api/materials";
import type { DeliverableDto, DeliveryDto, MaterialDetailDto, MaterialDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, optionsOf, type BadgeTone } from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeliveryFormModal } from "../components/DeliveryFormModal";
import { ItemEditModal } from "../components/ItemEditModal";
import { ItemFormModal } from "../components/ItemFormModal";
import { ItemModal } from "../components/ItemModal";
import { MaterialFormModal } from "../components/MaterialFormModal";
import { MaterialViewModal } from "../components/MaterialViewModal";
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
  const canCreateMaterial = can(role, "materials", "create");
  const canUpdateMaterial = can(role, "materials", "update");
  const canDeleteMaterial = can(role, "materials", "delete");

  const { data: delivery, refetch: refetchDelivery } = useQuery({
    queryKey: ["deliveries", deliveryId],
    queryFn: async () => (await api.get<{ data: DeliveryDto }>(`/deliveries/${deliveryId}`))?.data,
  });
  const { data: items, refetch: refetchItems } = useQuery({
    queryKey: ["deliveries", deliveryId, "items"],
    queryFn: async () =>
      (await api.get<{ data: DeliverableDto[] }>(`/deliveries/${deliveryId}/items`))?.data ?? [],
  });
  // K54：该交付单关联的资料
  const { data: materials, refetch: refetchMaterials } = useQuery({
    queryKey: ["materials", "delivery", deliveryId],
    queryFn: async () =>
      (await api.get<{ data: MaterialDto[] }>(`/materials${buildQuery({ deliveryId, pageSize: 100 })}`))?.data ?? [],
  });

  const [creatingItem, setCreatingItem] = useState(false);
  const [editingItem, setEditingItem] = useState<DeliverableDto | null>(null);
  const [deletingItem, setDeletingItem] = useState<DeliverableDto | null>(null);
  const [itemsOf, setItemsOf] = useState<DeliverableDto | null>(null);
  const [editingDelivery, setEditingDelivery] = useState(false);
  const [creatingMaterial, setCreatingMaterial] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<MaterialDetailDto | null>(null);
  const [viewingMaterial, setViewingMaterial] = useState<MaterialDetailDto | null>(null);
  const [deletingMaterial, setDeletingMaterial] = useState<MaterialDto | null>(null);
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

  // K54 资料：查看/修改前先拉 DetailDto（列表 DTO 不含完整 content）
  const openMaterial = async (id: number, apply: (m: MaterialDetailDto) => void) => {
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
      setCreatingMaterial(false);
      setEditingMaterial(null);
      await refetchMaterials();
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

  const confirmDeleteMaterial = async () => {
    if (!deletingMaterial) return;
    setBusy(true);
    try {
      await api.delete(`/materials/${deletingMaterial.id}`);
      setDeletingMaterial(null);
      await refetchMaterials();
      showToast("已删除");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
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
        <h1>{delivery.name ?? delivery.deliveryType?.name ?? `交付 #${delivery.id}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate("/deliveries")}>
            返回列表
          </button>
          <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}/gantt`)}>
            甘特图
          </button>
          <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}/matrix`)}>
            状态矩阵
          </button>
          {delivery.deliveryType?.kind === "circle" && (
            <button type="button" className="btn-primary" onClick={() => navigate(`/deliveries/${deliveryId}/circle`)}>
              圈子工作台
            </button>
          )}
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
            <span className="detail-label">交付名</span>
            <span>{delivery.name || "—"}</span>
          </div>
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

      <div className="card">
        <div className="card-head">
          <h2>资料</h2>
          {canCreateMaterial && (
            <button type="button" className="btn-primary" onClick={() => setCreatingMaterial(true)}>
              新增资料
            </button>
          )}
        </div>
        <div className="card-body-flush">
          {materials && materials.length === 0 && <div className="task-empty">暂无资料</div>}
          {materials?.map((m) => (
            <div className="item-row" key={m.id}>
              <div className="item-main">
                <div className="item-title">
                  {m.title}
                  <span className="badge-wrap">
                    {badge(materialKindLabels[m.kind as keyof typeof materialKindLabels] ?? m.kind)}
                    {m.tags.map((t) => (
                      <Fragment key={t.id}>{badge(t.name, "muted")}</Fragment>
                    ))}
                  </span>
                </div>
                <div className="item-meta">
                  {m.customers.length > 0 ? m.customers.map((c) => c.nickname).join("、") : "未关联客户"}
                </div>
              </div>
              <div className="row-actions">
                <button type="button" onClick={() => void openMaterial(m.id, setViewingMaterial)}>
                  查看
                </button>
                {m.kind === MATERIAL_FILE_KIND && (
                  <a href={materialFileUrl(m.id, true)}>下载</a>
                )}
                {canUpdateMaterial && (m.kind === "transcript" || m.kind === "text") && (
                  <button type="button" onClick={() => navigate(`/materials/${m.id}/edit`)}>
                    编辑内容
                  </button>
                )}
                {canUpdateMaterial && (
                  <button type="button" onClick={() => void openMaterial(m.id, setEditingMaterial)}>
                    修改
                  </button>
                )}
                {canDeleteMaterial && (
                  <button type="button" className="btn-danger" onClick={() => setDeletingMaterial(m)}>
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
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
        <ItemEditModal item={editingItem} busy={busy} onClose={() => setEditingItem(null)} onSubmit={updateItem} />
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
      {creatingMaterial && (
        <MaterialFormModal
          title="新增资料"
          fixedDeliveryId={deliveryId}
          busy={busy}
          onClose={() => setCreatingMaterial(false)}
          onSubmit={(body, file) => saveMaterial(body, null, file)}
        />
      )}
      {editingMaterial && (
        <MaterialFormModal
          title={`修改资料：${editingMaterial.title}`}
          material={editingMaterial}
          fixedDeliveryId={deliveryId}
          busy={busy}
          onClose={() => setEditingMaterial(null)}
          onSubmit={(body, file) => saveMaterial(body, editingMaterial, file)}
        />
      )}
      {viewingMaterial && (
        <MaterialViewModal material={viewingMaterial} canUpdate={canUpdateMaterial} onClose={() => setViewingMaterial(null)} />
      )}
      {deletingMaterial && (
        <ConfirmDialog
          title="删除资料"
          message={`确定删除资料「${deletingMaterial.title}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDeleteMaterial()}
          onCancel={() => setDeletingMaterial(null)}
        />
      )}
    </>
  );
}
