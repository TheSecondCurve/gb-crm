import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { can } from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import type {
  CommissionDefaultDto,
  CommissionDefaultRuleDto,
  DealCommissionDto,
  UserDto,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { badge, centsToYuan, dateToEpochMs, epochMsToDate } from "../columns/common";
import { Pagination } from "../components/DataGrid/DataGrid";
import { CommissionFormModal } from "../components/CommissionFormModal";
import { useToast } from "../components/Toast";

function percentText(p: number): string {  return `${(p * 100).toFixed(1)}%`;
}

function showAmount(cents: number | null): string {
  return cents === null ? "—" : `¥${centsToYuan(cents)}`;
}

function CommissionDefaultEditor() {
  const showToast = useToast();
  const queryClient = useQueryClient();
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
    if (config && rules.length === 0) setRules(config.rules);
  }, [config]);

  const setRule = (index: number, patch: Partial<CommissionDefaultRuleDto>) =>
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const addRule = () => setRules((p) => [...p, { source: "owner", percentage: 0 }]);
  const removeRule = (index: number) => setRules((p) => p.filter((_, i) => i !== index));

  const save = async () => {
    setBusy(true);
    try {
      await api.patch("/system/commission-default", { rules });
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
              未特殊配置的成交自动套用此方案。规则按角色推导:{' '}
              <code>归属人</code>=客户归属人、<code>成交负责人</code>=deals.owner_id、
              <code>指定人</code>=固定成员。总和不能超过 100%。
            </p>
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
                        <option value="owner">归属人</option>
                        <option value="dealOwner">成交负责人</option>
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
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<DealCommissionDto | null>(null);

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

  const revert = async (row: DealCommissionDto) => {
    try {
      await api.put(`/deals/${row.dealId}/commissions`, { items: [] });
      await invalidate();
      showToast("已还原为默认方案");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "还原失败，请稍后重试");
    }
  };

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
                <th>成交时间</th>
                <th>税后基数</th>
                <th>分成明细</th>
                <th>总比例</th>
                <th>总分成</th>
                <th>状态</th>
                {canUpdate && <th style={{ width: 140 }}>操作</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={canUpdate ? 8 : 7} className="empty-cell">
                    暂无成交数据
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.dealId}>
                  <td>{row.customer ? row.customer.nickname : "—"}</td>
                  <td>{epochMsToDate(row.deliveryDate)}</td>
                  <td>{showAmount(row.baseAmountCents)}</td>
                  <td>
                    {row.items.length === 0 ? (
                      "—"
                    ) : (
                      <span className="inline-badges">
                        {row.items.map((it) => (
                          <span key={it.userId}>
                            {badge(
                              `${it.nickname ?? `#${it.userId}`} ${percentText(it.percentage)}`,
                              "plain",
                            )}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>{percentText(row.totalPercentage)}</td>
                  <td>{showAmount(row.totalAmountCents)}</td>
                  <td>{badge(row.isCustomized ? "已配置" : "默认", row.isCustomized ? "accent" : "muted")}</td>
                  {canUpdate && (
                    <td>
                      <span className="row-actions">
                        <button type="button" onClick={() => setEditing(row)}>
                          配置
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
    </>
  );
}