import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can } from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import type {
  CommissionDefaultDto,
  CommissionDefaultRuleDto,
  CommissionItemDto,
  DealCommissionDto,
  DealPayoutDto,
  UserDto,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, centsToYuan, dateToEpochMs, epochMsToDate } from "../columns/common";
import { Pagination } from "../components/DataGrid/DataGrid";
import { CommissionFormModal } from "../components/CommissionFormModal";
import { PayoutFormModal } from "../components/PayoutFormModal";
import { useToast } from "../components/Toast";

function percentText(p: number): string {  return `${(p * 100).toFixed(1)}%`;
}

function showAmount(cents: number | null): string {
  return cents === null ? "—" : `¥${centsToYuan(cents)}`;
}

/** 单个参与方徽章文本：昵称 比例(金额) */
function itemText(it: CommissionItemDto): string {
  return `${it.nickname ?? `#${it.userId}`} ${percentText(it.percentage)}(${showAmount(it.amountCents)})`;
}

/** 参与方徽章列表（空 → —） */
function participantBadges(items: CommissionItemDto[]): ReactNode {
  if (items.length === 0) return "—";
  return (
    <span className="inline-badges">
      {items.map((it) => (
        <span key={it.userId}>{badge(itemText(it), "plain")}</span>
      ))}
    </span>
  );
}

/** 负责人分成：按 deals.owner_id 在明细里找到对应人的比例+金额；负责人未参与 → — */
function ownerSplitText(row: DealCommissionDto): string {
  const item = row.items.find((it) => it.userId === row.owner?.id);
  return item ? `${percentText(item.percentage)}(${showAmount(item.amountCents)})` : "—";
}

/** payout 徽章文本：日期 比例(金额 状态) */
function payoutText(p: DealPayoutDto): string {
  return `${epochMsToDate(p.payoutDate)} ${percentText(p.rate)}(${showAmount(p.amountCents)} ${p.status === "paid" ? "已发" : "待发"})`;
}

function CommissionDefaultEditor() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [totalRatio, setTotalRatio] = useState(0);
  const [rules, setRules] = useState<CommissionDefaultRuleDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["system", "commission-default"],
    queryFn: async () =>
      (await api.get<{ data: CommissionDefaultDto }>("/system/commission-default"))?.data,
  });

  const { data: members } = useQuery({
    queryKey: ["users", "select", "all"],
    queryFn: async () =>
      (await api.get<{ data: UserDto[] }>("/users?page=1&pageSize=100"))?.data ?? [],
  });
  const memberOptions = (members ?? []).filter((u) => u.accountStatus === "enabled");

  useEffect(() => {
    if (config) {
      setTotalRatio(config.totalRatio);
      setRules(config.rules);
    }
  }, [config]);

  const setRule = (index: number, patch: Partial<CommissionDefaultRuleDto>) =>
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const addRule = () => setRules((p) => [...p, { source: "user", percentage: 0 }]);
  const removeRule = (index: number) => setRules((p) => p.filter((_, i) => i !== index));

  const save = async () => {
    setBusy(true);
    try {
      await api.patch("/system/commission-default", { totalRatio, rules });
      await queryClient.invalidateQueries({ queryKey: ["system", "commission-default"] });
      await queryClient.invalidateQueries({ queryKey: ["deals", "commissions"] });
      showToast("已保存默认分成方案");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>默认分成方案</h2>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "编辑"}
        </button>
      </div>
      {open && (
        <>
          <div className="card-body">
            <p style={{ marginTop: 0, fontSize: 13 }}>
              未特殊配置的成交自动套用此方案：<strong>总比例</strong> 决定分红池（税后基数 × 总比例）；
              内部分配由 <code>成交负责人</code>、<code>客户归属人</code>（这两者总是参与）+ 可选
              <code>指定人</code> 共同分配，总和不能超过 100%。
            </p>
            <div className="settings-form">
              <label>
                总比例(%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={(totalRatio * 100).toFixed(1)}
                  onChange={(e) => setTotalRatio(Number(e.target.value) / 100 || 0)}
                />
              </label>
            </div>
            <table className="settings-form">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>来源</th>
                  <th style={{ textAlign: "left" }}>比例(%)</th>
                  <th style={{ textAlign: "left", width: "40%" }}>指定人</th>
                  <th style={{ width: 48 }} />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, i) => (
                  <tr key={i}>
                    <td>
                      <select
                        value={rule.source}
                        onChange={(e) =>
                          setRule(i, { source: e.target.value as CommissionDefaultRuleDto["source"] })
                        }
                      >
                        <option value="dealOwner">成交负责人</option>
                        <option value="owner">客户归属人</option>
                        <option value="user">指定人</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={(rule.percentage * 100).toFixed(1)}
                        onChange={(e) =>
                          setRule(i, { percentage: Number(e.target.value) / 100 || 0 })
                        }
                      />
                    </td>
                    <td>
                      {rule.source === "user" ? (
                        <select
                          value={rule.userId ?? ""}
                          onChange={(e) => setRule(i, { userId: Number(e.target.value) || undefined })}
                        >
                          <option value="">请选择成员…</option>
                          {memberOptions.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.nickname}(#{m.id})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ color: "#999", fontSize: 13 }}>按成交自动推导</span>
                      )}
                    </td>
                    <td>
                      <button type="button" onClick={() => removeRule(i)} aria-label="删除该行">
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card-footer">
            <button type="button" onClick={addRule}>
              加一行
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
              保存方案
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function DealCommissionsPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const canUpdate = can(role, "dealCommissions", "update");
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState("");
  const [payoutStatus, setPayoutStatus] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<DealCommissionDto | null>(null);
  const [payoutEditing, setPayoutEditing] = useState<DealCommissionDto | null>(null);

  const startMs = dateToEpochMs(startDate) ?? undefined;
  const endMs = dateToEpochMs(endDate);
  const endMsInclusive = endMs === null ? undefined : endMs + 86399999;

  const { data, isLoading } = useQuery({
    queryKey: [
      "deals",
      "commissions",
      page,
      pageSize,
      status,
      payoutStatus,
      startMs,
      endMsInclusive,
      q,
    ],
    queryFn: async () =>
      (await api.get<{ data: DealCommissionDto[]; meta: { total: number } }>(
        `/deals/commissions${buildQuery({
          page,
          pageSize,
          status,
          payoutStatus,
          startDate: startMs,
          endDate: endMsInclusive,
          q,
        })}`,
      )) ?? { data: [], meta: { total: 0 } },
  });

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["deals", "commissions"] });

  const saveCommission = async (items: { userId: number; percentage: number }[]) => {
    if (!editing) return;
    try {
      await api.put(`/deals/${editing.dealId}/commissions`, { items });
      setEditing(null);
      await invalidate();
      showToast("已保存成交分成");
    } catch (err) {
      showToast(
        err instanceof ApiError
          ? err.message
          : "保存失败，请稍后重试",
      );
    }
  };

  const savePayouts = async (payouts: { seq: 1 | 2; payoutDate: number; rate: number }[]) => {
    if (!payoutEditing) return;
    try {
      await api.put(`/deals/${payoutEditing.dealId}/payouts`, { payouts });
      setPayoutEditing(null);
      await invalidate();
      showToast("已保存 payout");
    } catch (err) {
      showToast(
        err instanceof ApiError
          ? err.message
          : "保存失败，请稍后重试",
      );
    }
  };

  const togglePayoutStatus = async (row: DealCommissionDto, p: DealPayoutDto) => {
    const next = p.status === "paid" ? "pending" : "paid";
    try {
      await api.patch(`/deals/${row.dealId}/payouts/${p.seq}`, { status: next });
      await invalidate();
      showToast(next === "paid" ? "已标记为已发" : "已标记为待发");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "更新失败，请稍后重试");
    }
  };

  const revert = async (row: DealCommissionDto) => {
    try {
      await api.put(`/deals/${row.dealId}/commissions`, { items: [] });
      await invalidate();
      showToast("已还原为默认方案");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "还原失败，请稍后重试");
    }
  };

  // 导出 Excel：跟随当前日期范围/状态/payout 状态/搜索（与列表同一 WHERE），同源 attachment 下载
  const exportXlsx = () => {
    const href = `/api/v1/deals/commissions/export.xlsx${buildQuery({
      q,
      status,
      payoutStatus,
      startDate: startMs,
      endDate: endMsInclusive,
    })}`;
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    a.click();
  };

  const COLUMN_COUNT = canUpdate ? 16 : 15;

  return (
    <>
      <div className="page-head">
        <h1>成交分成</h1>
        <div className="search-bar">
          <input
            aria-label="搜索"
            placeholder="搜索订单号/备注…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          <input
            aria-label="开始日期"
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setPage(1);
            }}
          />
          <span>~</span>
          <input
            aria-label="结束日期"
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="分成状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="default">未配置(默认)</option>
            <option value="custom">已配置</option>
          </select>
          <select
            aria-label="payout 状态"
            value={payoutStatus}
            onChange={(e) => {
              setPayoutStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部 payout</option>
            <option value="pending">待发</option>
            <option value="paid">已发</option>
          </select>
          <button type="button" onClick={exportXlsx}>
            导出 Excel
          </button>
        </div>
      </div>

      {role === "admin" && <CommissionDefaultEditor />}

      <div className="card">
        <div className="card-body-flush">
          <div className="data-grid-scroll">
            <table className="data-table" aria-busy={isLoading}>
              <thead>
              <tr>
                <th>客户</th>
                <th>客户归属人</th>
                <th>成交产品</th>
                <th>成交日期</th>
                <th>交付日期</th>
                <th>负责人</th>
                <th>成交金额</th>
                <th>税后基数</th>
                <th>总比例</th>
                <th>分红池</th>
                <th>负责人分成</th>
                <th>其他参与方</th>
                <th>内部分配</th>
                <th>总分成</th>
                <th>payout</th>
                <th>状态</th>
                {canUpdate && <th style={{ width: 180 }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className="empty-cell">
                    暂无成交数据
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.dealId}>
                  <td>{row.customer ? row.customer.nickname : "—"}</td>
                  <td>{row.customerOwner ? row.customerOwner.nickname : "—"}</td>
                  <td>{row.product ? row.product.name : "—"}</td>
                  <td>{epochMsToDate(row.dealDate)}</td>
                  <td>{row.deliveryDate === null ? "—" : epochMsToDate(row.deliveryDate)}</td>
                  <td>{row.owner ? row.owner.nickname : "—"}</td>
                  <td>{showAmount(row.amountCents)}</td>
                  <td>{showAmount(row.baseAmountCents)}</td>
                  <td>{percentText(row.totalRatio)}</td>
                  <td>{showAmount(row.poolAmountCents)}</td>
                  <td>{ownerSplitText(row)}</td>
                  <td>{participantBadges(row.items.filter((it) => it.userId !== row.owner?.id))}</td>
                  <td>{percentText(row.totalPercentage)}</td>
                  <td>{showAmount(row.totalAmountCents)}</td>
                  <td>
                    {row.payouts.length === 0 ? (
                      "—"
                    ) : (
                      <span className="inline-badges">
                        {row.payouts.map((p) => (
                          <span key={p.seq}>
                            <span>
                              {badge(payoutText(p), p.status === "paid" ? "accent" : "muted")}
                              {canUpdate && (
                                <button
                                  type="button"
                                  className="btn-small"
                                  aria-label={`切换第 ${p.seq} 期状态`}
                                  onClick={() => void togglePayoutStatus(row, p)}
                                >
                                  {p.status === "paid" ? "置待发" : "置已发"}
                                </button>
                              )}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>{badge(row.isCustomized ? "已配置" : "默认", row.isCustomized ? "accent" : "muted")}</td>
                  {canUpdate && (
                    <td>
                      <span className="row-actions">
                        <button type="button" onClick={() => setEditing(row)}>
                          配置分成
                        </button>
                        <button type="button" onClick={() => setPayoutEditing(row)}>
                          配置 payout
                        </button>
                        {row.isCustomized && (
                          <button type="button" onClick={() => void revert(row)}>
                            还原
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
        <div className="card-footer">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onChange={(p, s) => {
              setPage(p);
              setPageSize(s);
            }}
          />
        </div>
      </div>

      {editing && (
        <CommissionFormModal
          title={`配置分成：${editing.customer?.nickname ?? `#${editing.dealId}`}`}
          initialItems={editing.items}
          busy={false}
          onClose={() => setEditing(null)}
          onSubmit={saveCommission}
        />
      )}
      {payoutEditing && (
        <PayoutFormModal
          title={`配置 payout：${payoutEditing.customer?.nickname ?? `#${payoutEditing.dealId}`}`}
          initialPayouts={payoutEditing.payouts}
          busy={false}
          onClose={() => setPayoutEditing(null)}
          onSubmit={savePayouts}
        />
      )}
    </>
  );
}
