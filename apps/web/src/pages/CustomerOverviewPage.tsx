// 客户总览页（K45–K48）：基本信息 + AI 打标 + 客户统计 + 消费记录 + 当前有效交付圈子。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { can, customerTypeLabels, maintenanceKindLabels, materialKindLabels } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type {
  CustomerMaintenanceRecordDto,
  CustomerOverviewDto,
  MaterialDetailDto,
  TagDto,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, centsToYuan, enumBadge, epochMsToDate, formatDateTime, type BadgeTone } from "../columns/common";
import { MaintenanceRecordFormModal } from "../components/MaintenanceRecordFormModal";
import { MaterialViewModal } from "../components/MaterialViewModal";
import { useToast } from "../components/Toast";

const TAG_SCOPE_TONES: Record<string, BadgeTone> = {
  identity: "accent",
  stage: "plain",
  interest: "accent",
  other: "muted",
};

const DEAL_STAGE_TONES: Record<string, BadgeTone> = { paid: "accent", refunded: "muted", closed: "muted" };

const MAINTENANCE_KIND_TONES: Record<string, BadgeTone> = {
  follow_up: "accent",
  status_change: "danger",
  lead: "accent",
  note: "plain",
  other: "muted",
};

export function CustomerOverviewPage() {
  const { id } = useParams();
  const customerId = Number(id);
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const navigate = useNavigate();

  const canUpdate = can(role, "customers", "update");

  const { data: overview, refetch } = useQuery({
    queryKey: ["customers", customerId, "overview"],
    queryFn: async () =>
      (await api.get<{ data: CustomerOverviewDto }>(`/customers/${customerId}/overview`))?.data,
  });
  const { data: tagOptions = [] } = useQuery({
    queryKey: ["tags", "options"],
    queryFn: async () => (await api.get<{ data: TagDto[] }>("/tags?pageSize=100"))?.data ?? [],
  });

  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  // K54：查看资料（先 GET /materials/:id 拉完整 content 再开只读弹窗）
  const [viewingMaterial, setViewingMaterial] = useState<MaterialDetailDto | null>(null);

  // K55：维护记录弹窗（新增/编辑/删除）
  const [recordFormOpen, setRecordFormOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<CustomerMaintenanceRecordDto | null>(null);
  const [recordBusy, setRecordBusy] = useState(false);

  const openMaterial = async (id: number) => {
    try {
      const res = await api.get<{ data: MaterialDetailDto }>(`/materials/${id}`);
      if (res?.data) setViewingMaterial(res.data);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "加载资料失败，请稍后重试");
    }
  };

  const customer = overview?.customer;
  const currentTagIds = useMemo(
    () => new Set((customer?.tags ?? []).map((t) => t.id)),
    [customer?.tags],
  );
  const addableTags = useMemo(
    () => tagOptions.filter((t) => t.enabled && !currentTagIds.has(t.id)),
    [tagOptions, currentTagIds],
  );

  const toastError = (err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 409) showToast("数据已被他人更新，请刷新后重试");
    else showToast(err instanceof ApiError ? err.message : fallback);
  };

  const generateTags = async () => {
    setAiBusy(true);
    try {
      await api.post(`/customers/${customerId}/tags/generate`);
      setPicked([]);
      await refetch();
      showToast("AI 已更新标签与行业");
    } catch (err) {
      toastError(err, "AI 打标失败，请稍后重试");
    } finally {
      setAiBusy(false);
    }
  };

  const saveTags = async (tagIds: number[]) => {
    if (!customer) return;
    setSaving(true);
    try {
      await api.patch(`/customers/${customerId}`, { tagIds, updatedAt: customer.updatedAt });
      setPicked([]);
      await refetch();
      showToast("已保存标签");
    } catch (err) {
      toastError(err, "保存标签失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const removeTag = (tagId: number) => {
    if (!customer) return;
    void saveTags(customer.tags.filter((t) => t.id !== tagId).map((t) => t.id));
  };

  const addPicked = () => {
    if (!customer) return;
    void saveTags([...customer.tags.map((t) => t.id), ...picked]);
  };

  // K55 维护记录
  const canCreateRecord = can(role, "customerRecords", "create");
  const canWriteRecord = can(role, "customerRecords", "update");

  const openNewRecord = () => {
    setEditingRecord(null);
    setRecordFormOpen(true);
  };
  const openEditRecord = (r: CustomerMaintenanceRecordDto) => {
    setEditingRecord(r);
    setRecordFormOpen(true);
  };

  const submitRecord = async (body: Record<string, unknown>) => {
    if (!customer) return;
    setRecordBusy(true);
    const isEdit = editingRecord != null;
    try {
      if (isEdit) {
        await api.patch(`/customers/${customerId}/records/${editingRecord!.id}`, body);
      } else {
        await api.post(`/customers/${customerId}/records`, body);
      }
      setRecordFormOpen(false);
      setEditingRecord(null);
      await refetch();
      showToast(isEdit ? "已更新记录" : "已新增记录");
    } catch (err) {
      toastError(err, isEdit ? "更新记录失败，请稍后重试" : "新增记录失败，请稍后重试");
    } finally {
      setRecordBusy(false);
    }
  };

  const removeRecord = async (r: CustomerMaintenanceRecordDto) => {
    if (!window.confirm(`删除这条维护记录？`)) return;
    try {
      await api.delete(`/customers/${customerId}/records/${r.id}`);
      await refetch();
      showToast("已删除记录");
    } catch (err) {
      toastError(err, "删除记录失败，请稍后重试");
    }
  };

  if (!overview) {
    return <div className="page-loading">加载中…</div>;
  }

  const stats = overview.stats;

  return (
    <>
      <div className="page-head">
        <h1>{customer?.nickname ?? `客户 #${customerId}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate("/customers")}>
            返回列表
          </button>
          {canUpdate && (
            <button type="button" className="btn-primary" disabled={aiBusy} onClick={() => void generateTags()}>
              {aiBusy ? "AI 生成中…" : "AI 生成标签"}
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="detail-row">
            <span className="detail-label">标签</span>
            <span className="detail-chips">
              {(customer?.tags ?? []).length === 0 && <span className="muted-text">暂无标签</span>}
              {(customer?.tags ?? []).map((t) => (
                <span className="chip" key={t.id}>
                  {badge(t.name, TAG_SCOPE_TONES[t.scope] ?? "muted")}
                  {canUpdate && (
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`移除标签 ${t.name}`}
                      disabled={saving}
                      onClick={() => removeTag(t.id)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </span>
          </div>
          {canUpdate && addableTags.length > 0 && (
            <div className="detail-row">
              <span className="detail-label">添加标签</span>
              <span className="detail-chips">
                {addableTags.map((t) => (
                  <button
                    type="button"
                    className="chip chip-add"
                    key={t.id}
                    onClick={() =>
                      setPicked((prev) =>
                        prev.includes(t.id) ? prev.filter((v) => v !== t.id) : [...prev, t.id],
                      )
                    }
                  >
                    {picked.includes(t.id) ? "✓ " : "+ "}
                    {t.name}
                  </button>
                ))}
                <button type="button" className="btn-primary" disabled={saving || picked.length === 0} onClick={addPicked}>
                  保存
                </button>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="detail-row">
            <span className="detail-label">基本信息</span>
            <span className="detail-grid">
              <span>行业：{customer?.industry || "—"}</span>
              <span>真实姓名：{customer?.realName || "—"}</span>
              <span>称谓：{customer?.title || "—"}</span>
              <span>类型：{enumBadge(customerTypeLabels)(customer?.customerType ?? "")}</span>
              <span>手机号：{customer?.phone || "—"}</span>
              <span>微信号：{customer?.wechat || "—"}</span>
              <span>城市：{customer?.city || "—"}</span>
              <span>归属人：{customer?.owner?.nickname || "—"}</span>
              <span>来源渠道：{customer?.sourceChannels.map((c) => c.name).join("、") || "—"}</span>
              <span>最近跟进：{formatDateTime(customer?.lastFollowedAt ?? null) || "—"}</span>
              <span>创建：{formatDateTime(customer?.createdAt ?? null)}</span>
              <span>更新：{formatDateTime(customer?.updatedAt ?? null)}</span>
            </span>
          </div>
          <div className="detail-row">
            <span className="detail-label">元故事</span>
            <span>{customer?.originStory || "—"}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">备注</span>
            <span>{customer?.notes || "—"}</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>客户统计</h2>
        </div>
        <div className="card-body">
          <div className="stats-grid">
            <div className="stat-item">
              <div className="stat-value">{stats.dealCount}</div>
              <div className="stat-label">成交笔数</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{centsToYuan(stats.paidTotalCents)}</div>
              <div className="stat-label">累计实付（元）</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{formatDateTime(stats.lastDealAt) || "—"}</div>
              <div className="stat-label">最近成交时间</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{overview.circles.length}</div>
              <div className="stat-label">当前圈子数</div>
            </div>
            <div className="stat-item">
              <div className="stat-value">{stats.materialCount}</div>
              <div className="stat-label">资料数</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>资料（{stats.materialCount}）</h2>
        </div>
        <div className="card-body-flush">
          {overview.materials.length === 0 && <div className="task-empty">暂无资料</div>}
          {overview.materials.map((m) => (
            <div className="item-row" key={m.id}>
              <div className="item-main">
                <div className="item-title">
                  {m.title}
                  <span className="badge-wrap">
                    {badge(materialKindLabels[m.kind as keyof typeof materialKindLabels] ?? m.kind)}
                  </span>
                </div>
                <div className="item-meta">
                  {m.delivery ? `关联交付：${m.delivery.deliveryType?.name ?? `交付 #${m.delivery.id}`}` : "未关联交付"}
                  {` · 更新于 ${formatDateTime(m.updatedAt)}`}
                </div>
              </div>
              <div className="row-actions">
                <button type="button" onClick={() => void openMaterial(m.id)}>
                  查看
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>消费记录（{stats.dealCount}）</h2>
        </div>
        <div className="card-body-flush">
          {overview.deals.length === 0 && <div className="task-empty">暂无成交记录</div>}
          {overview.deals.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>意向产品</th>
                  <th>阶段</th>
                  <th>金额（元）</th>
                  <th>订单号</th>
                  <th>交付日期</th>
                  <th>成交时间</th>
                </tr>
              </thead>
              <tbody>
                {overview.deals.map((d) => (
                  <tr key={d.id}>
                    <td>{d.product?.name ?? "—"}</td>
                    <td>{badge(d.stage, DEAL_STAGE_TONES[d.stage] ?? "plain")}</td>
                    <td>{centsToYuan(d.amountCents) || "—"}</td>
                    <td>{d.orderNo || "—"}</td>
                    <td>{epochMsToDate(d.deliveryDate) || "—"}</td>
                    <td>{formatDateTime(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>当前交付圈子</h2>
        </div>
        <div className="card-body">
          {overview.circles.length === 0 && <div className="task-empty">暂无当前有效的交付圈子</div>}
          {overview.circles.map((c) => (
            <div className="detail-row" key={c.id}>
              <span className="detail-label">{c.deliveryType?.name ?? `圈子 #${c.id}`}</span>
              <span>
                {epochMsToDate(c.startsAt) || "未排期"} ~ {epochMsToDate(c.endsAt) || "未排期"}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => navigate(`/deliveries/${c.id}/circle`)}
                >
                  圈子工作台
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>维护记录（{stats.maintenanceRecordCount}）</h2>
          {canCreateRecord && (
            <button type="button" className="btn-primary" onClick={openNewRecord}>
              新增记录
            </button>
          )}
        </div>
        <div className="card-body-flush">
          {(overview.maintenanceRecords ?? []).length === 0 && <div className="task-empty">暂无维护记录</div>}
          {(overview.maintenanceRecords ?? []).map((r) => (
            <div className="item-row" key={r.id}>
              <div className="item-main">
                <div className="item-title">
                  {badge(maintenanceKindLabels[r.kind as keyof typeof maintenanceKindLabels] ?? r.kind, MAINTENANCE_KIND_TONES[r.kind] ?? "plain")}
                  {r.content || <span className="muted-text">（无内容）</span>}
                </div>
                <div className="item-meta">
                  {`记录于 ${epochMsToDate(r.happenedAt)} · ${r.createdBy?.nickname ?? "系统"}`}
                </div>
              </div>
              {canWriteRecord && (
                <div className="row-actions">
                  <button type="button" onClick={() => openEditRecord(r)}>
                    编辑
                  </button>
                  <button type="button" className="link-button" onClick={() => void removeRecord(r)}>
                    删除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {viewingMaterial && (
        <MaterialViewModal material={viewingMaterial} onClose={() => setViewingMaterial(null)} />
      )}

      {recordFormOpen && (
        <MaintenanceRecordFormModal
          title={editingRecord ? "编辑维护记录" : "新增维护记录"}
          record={editingRecord ?? undefined}
          busy={recordBusy}
          onClose={() => {
            setRecordFormOpen(false);
            setEditingRecord(null);
          }}
          onSubmit={submitRecord}
        />
      )}
    </>
  );
}
