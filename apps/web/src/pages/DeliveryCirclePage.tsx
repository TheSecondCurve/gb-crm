// 圈子类交付专项工作台（/deliveries/:id/circle）：
// - 以单个圈子类交付单为单位：基本信息（类型/起止日期/人数/周期状态/进度）+ Tab 分区：
//   「圈子客户」（全量客户表：导出 Excel、添加/移除快速维护）与「交付工作项」
//   （交付项维护 + 甘特图与时序 todo，复用 DeliveryGantt）；
// - 客户维度交付项「动作」→ 弹出状态矩阵弹窗（components/DeliveryMatrix，格内打勾即改）；
//   项目维度仍是动作清单弹窗（ItemModal）；
// - 仅 deliveryType.kind === "circle" 有入口；直接访问非圈子类 → 提示守卫；
// - assistant 只读（canUpdate 门控全部写操作）。
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, deliverableDimensionLabels, deliveryTypeKindLabels } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type { CustomerDto, DeliverableDto, DeliveryDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, enumBadge, epochMsToDate, optionsOf, type BadgeTone } from "../columns/common";
import {
  circleCustomerFields,
  loadCircleCustomerVisibleKeys,
  saveCircleCustomerVisibleKeys,
} from "../columns/circleCustomerFields";
import { customerOptionsLoader } from "../columns/relation";
import { ColumnPicker } from "../components/DataGrid/ColumnPicker";
import { storageKeyOf, type RelationOption } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DeliveryFormModal } from "../components/DeliveryFormModal";
import { DeliveryGantt } from "../components/DeliveryGantt";
import { DeliveryMatrix } from "../components/DeliveryMatrix";
import { ItemEditModal } from "../components/ItemEditModal";
import { ItemFormModal } from "../components/ItemFormModal";
import { ItemModal } from "../components/ItemModal";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

const DIM_TONES: Record<string, BadgeTone> = { customer: "accent" };

/** 客户表字段显隐持久化 key（DataGrid 同款规范） */
const FIELDS_STORAGE_KEY = storageKeyOf("delivery-circle-customers");

/** 周期状态（由起止日期 vs now 派生）：未排期 / 未开始 / 进行中 / 已结束 */
function cycleStatus(d: DeliveryDto, nowMs: number): { label: string; tone: BadgeTone } {
  if (d.startsAt === null && d.endsAt === null) return { label: "未排期", tone: "plain" };
  if (d.startsAt !== null && nowMs < d.startsAt) return { label: "未开始", tone: "plain" };
  if (d.endsAt !== null && nowMs > d.endsAt) return { label: "已结束", tone: "plain" };
  return { label: "进行中", tone: "accent" };
}

/** 添加圈子客户：搜索多选（排除已在圈内的客户）→ PATCH customerIds 并集 */
function AddCustomerModal({
  existingIds,
  busy,
  onClose,
  onSubmit,
}: {
  existingIds: number[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (ids: number[]) => Promise<void>;
}) {
  const showToast = useToast();
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [selected, setSelected] = useState<number[]>([]);

  // 300ms 防抖搜索（loader 承担查询；过滤掉已在圈内的客户）
  useEffect(() => {
    const timer = setTimeout(() => {
      void customerOptionsLoader(search).then((list) =>
        setOptions(list.filter((o) => !existingIds.includes(o.id))),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [search, existingIds]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) {
      showToast("请选择要添加的客户");
      return;
    }
    void onSubmit(selected);
  };

  return (
    <Modal title="添加圈子客户" onClose={onClose} form>
      <form className="form-grid" onSubmit={submit}>
        <div className="field field-span">
          搜索客户（已选 {selected.length} 人）
          <div className="form-picker">
            <input
              placeholder="搜索客户…"
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="form-checks">
              {options.map((o) => (
                <label className="inline-field" key={o.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(o.id)}
                    onChange={() =>
                      setSelected((prev) =>
                        prev.includes(o.id) ? prev.filter((v) => v !== o.id) : [...prev, o.id],
                      )
                    }
                  />
                  {o.label}
                </label>
              ))}
            </div>
            {search === "" && options.length === 0 && <div className="task-empty">输入关键字搜索客户</div>}
          </div>
        </div>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            添加
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeliveryCirclePage() {
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
  const { data: customers, refetch: refetchCustomers } = useQuery({
    queryKey: ["deliveries", deliveryId, "customers"],
    queryFn: async () =>
      (await api.get<{ data: CustomerDto[] }>(`/deliveries/${deliveryId}/customers`))?.data ?? [],
  });

  const [editingDelivery, setEditingDelivery] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);
  const [editingItem, setEditingItem] = useState<DeliverableDto | null>(null);
  const [deletingItem, setDeletingItem] = useState<DeliverableDto | null>(null);
  const [itemsOf, setItemsOf] = useState<DeliverableDto | null>(null);
  /** 客户维度交付项「动作」→ 状态矩阵弹窗 */
  const [matrixOf, setMatrixOf] = useState<DeliverableDto | null>(null);
  const [addingCustomers, setAddingCustomers] = useState(false);
  const [removingCustomer, setRemovingCustomer] = useState<CustomerDto | null>(null);
  const [busy, setBusy] = useState(false);
  /** Tab 分区：圈子客户 / 交付工作项 */
  const [tab, setTab] = useState<"customers" | "work">("customers");

  // 客户表字段显隐（自由选择展示字段；导出 Excel 按所选字段导出）
  const [visibleFieldKeys, setVisibleFieldKeys] = useState<string[]>(() =>
    loadCircleCustomerVisibleKeys(FIELDS_STORAGE_KEY),
  );
  const changeVisibleFieldKeys = useCallback((next: string[]) => {
    setVisibleFieldKeys(next);
    saveCircleCustomerVisibleKeys(FIELDS_STORAGE_KEY, next);
  }, []);
  const visibleFields = useMemo(
    () => circleCustomerFields.filter((f) => f.locked || visibleFieldKeys.includes(f.key)),
    [visibleFieldKeys],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([refetchDelivery(), refetchItems(), refetchCustomers()]);
  }, [refetchDelivery, refetchItems, refetchCustomers]);

  // 动作进度 + 客户维度覆盖（覆盖 = 该客户全部客户维度任务均已打勾）
  const progress = useMemo(() => {
    const list = items ?? [];
    const done = list.reduce((acc, it) => acc + it.tasks.filter((t) => t.done).length, 0);
    const total = list.reduce((acc, it) => acc + it.tasks.length, 0);
    const customerItems = list.filter((i) => i.dimension === "customer");
    const covered =
      customerItems.length === 0
        ? 0
        : (delivery?.customers ?? []).filter((c) =>
            customerItems.every((item) => item.tasks.find((t) => t.customer?.id === c.id)?.done === true),
          ).length;
    return { done, total, covered, customerItemCount: customerItems.length };
  }, [items, delivery]);

  const patchDeliveryCustomers = async (customerIds: number[]) => {
    if (!delivery) return;
    await api.patch(`/deliveries/${deliveryId}`, {
      customerIds,
      updatedAt: delivery.updatedAt,
    });
  };

  const saveDelivery = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.patch(`/deliveries/${deliveryId}`, body);
      setEditingDelivery(false);
      await refreshAll();
      showToast("已保存");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该交付已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "保存失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const addCustomers = async (ids: number[]) => {
    if (!delivery) return;
    setBusy(true);
    try {
      const union = [...new Set([...delivery.customers.map((c) => c.id), ...ids])];
      await patchDeliveryCustomers(union);
      setAddingCustomers(false);
      await refreshAll();
      showToast("已添加客户");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该交付已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "添加失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirmRemoveCustomer = async () => {
    if (!delivery || !removingCustomer) return;
    setBusy(true);
    try {
      const next = delivery.customers.filter((c) => c.id !== removingCustomer.id).map((c) => c.id);
      await patchDeliveryCustomers(next);
      setRemovingCustomer(null);
      await refreshAll();
      showToast("已移除客户");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该交付已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "移除失败，请稍后重试",
      );
    } finally {
      setBusy(false);
    }
  };

  const createItem = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post(`/deliveries/${deliveryId}/items`, body);
      setCreatingItem(false);
      await refetchItems();
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
      await refetchItems();
      showToast("已保存");
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "该行已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "保存失败，请稍后重试",
      );
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
      await refetchItems();
      showToast("已删除");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const exportXlsx = () => {
    const params = new URLSearchParams({ fields: visibleFieldKeys.join(",") });
    const href = `/api/v1/deliveries/${deliveryId}/customers/export.xlsx?${params.toString()}`;
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    a.click();
  };

  if (!delivery) {
    return <div className="page-loading">加载中…</div>;
  }

  // 守卫：非圈子类交付（直达 URL）→ 提示并回详情
  if (delivery.deliveryType?.kind !== "circle") {
    return (
      <>
        <div className="page-head">
          <h1>圈子工作台</h1>
          <div className="search-bar">
            <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}`)}>
              返回详情
            </button>
          </div>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="task-empty">该交付不是圈子类交付，无法使用圈子工作台</div>
          </div>
        </div>
      </>
    );
  }

  const status = cycleStatus(delivery, Date.now());
  const customerCount = delivery.customers.length;
  const typeLabel = delivery.deliveryType
    ? (deliveryTypeKindLabels[delivery.deliveryType.kind as keyof typeof deliveryTypeKindLabels] ??
      delivery.deliveryType.kind)
    : "—";
  const typeBadge = enumBadge(deliveryTypeKindLabels);

  return (
    <>
      <div className="page-head">
        <h1>圈子工作台 · {delivery.name ?? delivery.deliveryType?.name ?? `交付 #${deliveryId}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate("/deliveries")}>
            返回列表
          </button>
          <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}`)}>
            返回详情
          </button>
          {canUpdate && (
            <button type="button" className="btn-primary" onClick={() => setEditingDelivery(true)}>
              修改交付
            </button>
          )}
        </div>
      </div>

      {/* 圈子基本信息 */}
      <div className="card">
        <div className="card-head">
          <h2>圈子基本信息</h2>
          {typeBadge(delivery.deliveryType?.kind ?? null)}
        </div>
        <div className="card-body">
          <div className="circle-stats">
            <div className="circle-stat">
              <span className="circle-stat-value">{customerCount} 人</span>
              <span className="circle-stat-label">圈内客户</span>
            </div>
            <div className="circle-stat">
              <span className="circle-stat-value">
                {badge(status.label, status.tone)}
              </span>
              <span className="circle-stat-label">周期状态</span>
            </div>
            <div className="circle-stat">
              <span className="circle-stat-value">
                {progress.total > 0
                  ? badge(`${progress.done}/${progress.total}`, progress.done === progress.total ? "accent" : "plain")
                  : "—"}
              </span>
              <span className="circle-stat-label">动作进度</span>
            </div>
            {progress.customerItemCount > 0 && (
              <div className="circle-stat">
                <span className="circle-stat-value">
                  {badge(`${progress.covered}/${customerCount}`, progress.covered === customerCount ? "accent" : "plain")}
                </span>
                <span className="circle-stat-label">客户已全数覆盖</span>
              </div>
            )}
          </div>
          <div className="detail-row">
            <span className="detail-label">交付名</span>
            <span>{delivery.name || "—"}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">交付类型</span>
            <span>{delivery.deliveryType?.name ?? "—"}（{typeLabel}）</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">起始日期</span>
            <span>
              {delivery.startsAt ? epochMsToDate(delivery.startsAt) : "—"} ~ {delivery.endsAt ? epochMsToDate(delivery.endsAt) : "—"}
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">备注</span>
            <span>{delivery.remark || "—"}</span>
          </div>
        </div>
      </div>

      {/* Tab 分区：圈子客户 / 交付工作项 */}
      <div className="tabs" role="tablist" aria-label="圈子工作台">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "customers"}
          onClick={() => setTab("customers")}
        >
          圈子客户（{customerCount}）
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "work"}
          onClick={() => setTab("work")}
        >
          交付工作项（{items?.length ?? 0}）
        </button>
      </div>

      {tab === "customers" && (
        <>
          {/* 圈子客户：全量信息 + 导出 Excel + 添加/移除 */}
          <div className="card">
            <div className="card-head">
              <h2>圈子客户（{customerCount} 人）</h2>
              <div className="search-bar">
                <ColumnPicker
                  columns={circleCustomerFields.map(({ key, label, locked }) => ({ key, label, locked }))}
                  visibleKeys={visibleFieldKeys}
                  onChange={changeVisibleFieldKeys}
                />
                <button type="button" onClick={exportXlsx}>
                  导出 Excel
                </button>
                {canUpdate && (
                  <button type="button" className="btn-primary" onClick={() => setAddingCustomers(true)}>
                    添加客户
                  </button>
                )}
              </div>
            </div>
            <div className="card-body-flush">
              {customers && customers.length === 0 ? (
                <div className="task-empty">暂无客户，点击「添加客户」拉人进圈</div>
              ) : (
                <div className="matrix-scroll">
                  <table className="matrix-table circle-customer-table">
                    <thead>
                      <tr>
                        {visibleFields.map((f) => (
                          <th key={f.key} className={f.locked ? "matrix-corner" : undefined}>
                            {f.label}
                          </th>
                        ))}
                        {canUpdate && <th className="matrix-corner">操作</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {customers?.map((c) => (
                        <tr key={c.id}>
                          {visibleFields.map((f) =>
                            f.key === "nickname" ? (
                              <th key={f.key} className="matrix-row-head">
                                {f.render(c)}
                              </th>
                            ) : (
                              <td key={f.key}>{f.render(c)}</td>
                            ),
                          )}
                          {canUpdate && (
                            <td>
                              <button type="button" className="btn-danger" onClick={() => setRemovingCustomer(c)}>
                                移除
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "work" && (
        <>
          {/* 当前交付项 + 快速维护 */}
      <div className="card">
        <div className="card-head">
          <h2>当前交付项（{items?.length ?? 0}）</h2>
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
                      ? `${customerCovered}/${customerCount} 客户已覆盖 · 打勾 ${done}/${item.tasks.length}`
                      : `打勾 ${done}/${item.tasks.length}`}
                    {item.description ? ` · ${item.description}` : ""}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    onClick={() =>
                      item.dimension === "customer" ? setMatrixOf(item) : setItemsOf(item)
                    }
                  >
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

      {/* 甘特图 + 时序 todo（项目维度交付项） */}
      <DeliveryGantt
        deliveryId={deliveryId}
        delivery={delivery}
        items={items}
        canUpdate={canUpdate}
        onItemsChanged={() => void refetchItems()}
      />
        </>
      )}

      {addingCustomers && delivery && (
        <AddCustomerModal
          existingIds={delivery.customers.map((c) => c.id)}
          busy={busy}
          onClose={() => setAddingCustomers(false)}
          onSubmit={addCustomers}
        />
      )}
      {removingCustomer && (
        <ConfirmDialog
          title="移除客户"
          message={`确定把客户「${removingCustomer.nickname}」移出该圈子吗？不影响客户档案。`}
          confirmText="移除"
          loading={busy}
          onConfirm={() => void confirmRemoveCustomer()}
          onCancel={() => setRemovingCustomer(null)}
        />
      )}
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
        <ItemModal deliveryId={deliveryId} item={itemsOf} onClose={() => setItemsOf(null)} onChange={() => void refetchItems()} />
      )}
      {matrixOf && delivery && (
        <Modal title={`状态矩阵：${matrixOf.content}`} form onClose={() => setMatrixOf(null)}>
          <DeliveryMatrix
            deliveryId={deliveryId}
            customers={delivery.customers}
            items={items}
            canUpdate={canUpdate}
            onChanged={() => void refetchItems()}
          />
        </Modal>
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
