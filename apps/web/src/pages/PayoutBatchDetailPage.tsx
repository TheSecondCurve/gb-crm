import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { can, payoutBatchStatusLabels } from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import type {
  PayoutBatchCandidateDto,
  PayoutBatchDetailDto,
  PayoutBatchItemDto,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  centsToYuan,
  dateToEpochMs,
  enumBadge,
  epochMsToDate,
  formatDateTime,
  type BadgeTone,
} from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

const DAY_TAIL_MS = 86399999;

const BATCH_TONES: Record<string, BadgeTone> = {
  draft: "muted",
  locked: "plain",
  paid: "accent",
};
const batchBadge = enumBadge(payoutBatchStatusLabels, BATCH_TONES);

const PAYOUT_STATUS_LABELS: Record<PayoutBatchItemDto["payoutStatus"], string> = {
  pending: "待发",
  paid: "已发",
  missing: "已失效",
};
const PAYOUT_STATUS_TONES: Record<PayoutBatchItemDto["payoutStatus"], BadgeTone> = {
  pending: "muted",
  paid: "accent",
  missing: "danger",
};
const payoutStatusBadge = enumBadge(PAYOUT_STATUS_LABELS, PAYOUT_STATUS_TONES);

const percentText = (p: number): string => `${(p * 100).toFixed(1)}%`;

/** 各参与人分摊展示：昵称 ¥x 列表；空 → — */
function sharesText(item: Pick<PayoutBatchItemDto, "shares">) {
  if (item.shares.length === 0) return "—";
  return (
    <span className="cell-stack">
      {item.shares.map((s) => (
        <span key={s.userId}>
          {s.nickname ?? `#${s.userId}`} ¥{centsToYuan(s.amountCents)}
        </span>
      ))}
    </span>
  );
}

type ConfirmState = "lock" | "unlock" | "markPaid" | "delete";

/** 添加明细弹窗（draft）：日期范围过滤候选 → checkbox 多选 → 逐条 POST items */
function AddItemsModal({
  batchId,
  busy,
  onClose,
  onSubmit,
}: {
  batchId: number;
  busy: boolean;
  onClose: () => void;
  onSubmit: (selected: PayoutBatchCandidateDto[]) => Promise<void>;
}) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const startMs = dateToEpochMs(startDate);
  const endMs = dateToEpochMs(endDate);

  const { data: candidates, isLoading } = useQuery({
    queryKey: ["payout-batches", "candidates", batchId, startMs, endMs],
    queryFn: async () =>
      (await api.get<{ data: PayoutBatchCandidateDto[] }>(
        `/payout-batches/candidates${buildQuery({
          startDate: startMs ?? undefined,
          endDate: endMs === null ? undefined : endMs + DAY_TAIL_MS,
        })}`,
      ))?.data ?? [],
  });

  const rows = candidates ?? [];
  const keyOf = (c: PayoutBatchCandidateDto) => `${c.dealId}:${c.seq}`;

  const toggle = (c: PayoutBatchCandidateDto) => {
    if (c.activeBatchId !== null) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(c);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  return (
    <Modal title="添加明细" onClose={onClose} form>
      <div className="form-grid">
        <label className="field">
          开始日期
          <input
            type="date"
            aria-label="候选开始日期"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label className="field">
          结束日期
          <input
            type="date"
            aria-label="候选结束日期"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>
        <div className="field field-span">
          待发 payout 候选（已选 {selected.size} 条）
          <div className="form-checks">
            {isLoading && <div className="task-empty">加载中…</div>}
            {!isLoading && rows.length === 0 && (
              <div className="task-empty">该范围内没有待发的 payout</div>
            )}
            {rows.map((c) => {
              const occupied = c.activeBatchId !== null;
              return (
                <label className="inline-field" key={keyOf(c)} style={occupied ? { opacity: 0.55 } : undefined}>
                  <input
                    type="checkbox"
                    disabled={occupied}
                    checked={selected.has(keyOf(c))}
                    onChange={() => toggle(c)}
                  />
                  {c.customer?.nickname ?? "—"} · {c.product?.name ?? "—"} · 第{c.seq}期 ·{" "}
                  {epochMsToDate(c.payoutDate)} · ¥{centsToYuan(c.payoutAmountCents)}
                  {occupied && (
                    <span className="cell-sub">（已在批次：{c.activeBatchName ?? `#${c.activeBatchId}`}）</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || selected.size === 0}
            onClick={() => void onSubmit(rows.filter((c) => selected.has(keyOf(c))))}
          >
            添加所选
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** K59 分成发放：批次详情（信息卡 + 人员汇总 + 发放明细） */
export function PayoutBatchDetailPage() {
  const { id } = useParams();
  const batchId = Number(id);
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const canUpdate = can(role, "dealCommissions", "update");
  const showToast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data: detail, isLoading } = useQuery({
    queryKey: ["payout-batches", "detail", batchId],
    queryFn: async () =>
      (await api.get<{ data: PayoutBatchDetailDto }>(`/payout-batches/${batchId}`))?.data,
  });

  const [nameDraft, setNameDraft] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [removing, setRemoving] = useState<PayoutBatchItemDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const batch = detail?.batch;
  useEffect(() => {
    if (batch) setNameDraft(batch.name);
  }, [batch]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["payout-batches"] });

  /** 人员汇总：union 所有 byMonth.month 动态列（升序），底部总计行 */
  const summaryMonths = useMemo(() => {
    const set = new Set<string>();
    for (const entry of detail?.summary ?? []) {
      for (const m of entry.byMonth) set.add(m.month);
    }
    return [...set].sort();
  }, [detail]);

  const summaryTotals = useMemo(() => {
    const byMonth = new Map<string, number>();
    let total = 0;
    for (const entry of detail?.summary ?? []) {
      total += entry.totalAmountCents;
      for (const m of entry.byMonth) {
        byMonth.set(m.month, (byMonth.get(m.month) ?? 0) + m.amountCents);
      }
    }
    return { total, byMonth };
  }, [detail]);

  const saveName = async () => {
    const name = nameDraft.trim();
    if (!batch || name === "" || name === batch.name) return;
    setBusy(true);
    try {
      await api.patch(`/payout-batches/${batchId}`, { name });
      await invalidate();
      showToast("已保存批次名");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm || !batch) return;
    setBusy(true);
    try {
      if (confirm === "lock") {
        await api.post(`/payout-batches/${batchId}/lock`, {});
        showToast("批次已锁定");
      } else if (confirm === "unlock") {
        await api.post(`/payout-batches/${batchId}/unlock`, {});
        showToast("已解锁，回到草稿状态");
      } else if (confirm === "markPaid") {
        const res = await api.post<{ data: PayoutBatchDetailDto; meta: { marked: number; skipped: number } }>(
          `/payout-batches/${batchId}/mark-paid`,
          {},
        );
        const meta = res?.meta;
        showToast(
          meta
            ? `已标记 ${meta.marked} 条为已发${meta.skipped > 0 ? `，跳过 ${meta.skipped} 条` : ""}`
            : "已标记已发",
        );
      } else {
        await api.delete(`/payout-batches/${batchId}`);
        showToast("已删除批次");
        navigate("/deals/payout-batches");
        return;
      }
      setConfirm(null);
      await invalidate();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.delete(`/payout-batches/${batchId}/items/${removing.id}`);
      setRemoving(null);
      await invalidate();
      showToast("已移除明细");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "移除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const addItems = async (selected: PayoutBatchCandidateDto[]) => {
    setBusy(true);
    try {
      for (const c of selected) {
        await api.post(`/payout-batches/${batchId}/items`, { dealId: c.dealId, seq: c.seq });
      }
      setAdding(false);
      await invalidate();
      showToast(`已添加 ${selected.length} 条明细`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "添加失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !batch || !detail) {
    return <div className="page-loading">加载中…</div>;
  }

  const items = detail.items;
  const confirmMessage = (() => {
    switch (confirm) {
      case "lock":
        return `确定锁定批次「${batch.name}」？锁定后不可增删明细，金额与分摊将按当前数据生成快照供查账。`;
      case "unlock":
        return `确定解锁批次「${batch.name}」？锁定时的金额与分摊快照将被清空，回到草稿状态。`;
      case "markPaid":
        return `确定把批次「${batch.name}」标记为已发放？批次内全部待发 payout 将置为已发，操作不可撤销。`;
      case "delete":
        return `确定删除批次「${batch.name}」？批次的全部明细将一并移除，不可恢复。`;
      default:
        return "";
    }
  })();

  return (
    <>
      <div className="page-head">
        <h1>批次详情</h1>
        <div className="search-bar">
          <Link to="/deals/payout-batches">返回列表</Link>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            {batch.name} {batchBadge(batch.status)}
          </h2>
          <div className="row-actions">
            {batch.status !== "draft" && (
              <a href={`/api/v1/payout-batches/${batchId}/export.xlsx`} download="">
                导出 xlsx
              </a>
            )}
            {canUpdate && batch.status === "draft" && (
              <>
                <button type="button" onClick={() => setAdding(true)}>
                  添加明细
                </button>
                <button type="button" className="btn-primary" onClick={() => setConfirm("lock")}>
                  锁定批次
                </button>
                <button type="button" onClick={() => setConfirm("delete")}>
                  删除批次
                </button>
              </>
            )}
            {canUpdate && batch.status === "locked" && (
              <>
                <button type="button" className="btn-primary" onClick={() => setConfirm("markPaid")}>
                  标记已发
                </button>
                <button type="button" onClick={() => setConfirm("unlock")}>
                  解锁
                </button>
              </>
            )}
          </div>
        </div>
        <div className="card-body">
          <div className="settings-form">
            {canUpdate && batch.status === "draft" ? (
              <label>
                批次名
                <input
                  aria-label="批次名"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                />
              </label>
            ) : null}
            <span className="cell-sub">
              日期范围 {epochMsToDate(batch.rangeStart)} ~ {epochMsToDate(batch.rangeEnd)} · 明细{" "}
              {batch.itemCount} 条 · 总金额 ¥{centsToYuan(batch.totalAmountCents)}
              {batch.lockedAt !== null && ` · 锁定于 ${formatDateTime(batch.lockedAt)}`}
              {batch.paidAt !== null && ` · 发放于 ${formatDateTime(batch.paidAt)}`}
            </span>
          </div>
          {canUpdate && batch.status === "draft" && nameDraft.trim() !== batch.name && (
            <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || nameDraft.trim() === ""}
                onClick={() => void saveName()}
              >
                保存名称
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>人员汇总</h2>
        </div>
        <div className="card-body-flush">
          <div className="data-grid-scroll">
            <table className="data-table data-grid-table">
              <thead>
                <tr>
                  <th>参与人</th>
                  <th>合计金额</th>
                  {summaryMonths.map((m) => (
                    <th key={m}>{m} 成交</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.summary.length === 0 && (
                  <tr>
                    <td colSpan={2 + summaryMonths.length} className="empty-cell">
                      暂无汇总数据
                    </td>
                  </tr>
                )}
                {detail.summary.map((entry) => (
                  <tr key={entry.userId}>
                    <td>{entry.nickname ?? `#${entry.userId}`}</td>
                    <td>
                      <strong>¥{centsToYuan(entry.totalAmountCents)}</strong>
                    </td>
                    {summaryMonths.map((m) => (
                      <td key={m}>
                        {(() => {
                          const hit = entry.byMonth.find((x) => x.month === m);
                          return hit ? `¥${centsToYuan(hit.amountCents)}` : "—";
                        })()}
                      </td>
                    ))}
                  </tr>
                ))}
                {detail.summary.length > 0 && (
                  <tr>
                    <td>
                      <strong>总计</strong>
                    </td>
                    <td>
                      <strong>¥{centsToYuan(summaryTotals.total)}</strong>
                    </td>
                    {summaryMonths.map((m) => (
                      <td key={m}>
                        <strong>¥{centsToYuan(summaryTotals.byMonth.get(m) ?? 0)}</strong>
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>发放明细</h2>
        </div>
        <div className="card-body-flush">
          <div className="data-grid-scroll">
            <table className="data-table data-grid-table">
              <thead>
                <tr>
                  <th>成交日期</th>
                  <th>客户</th>
                  <th>产品</th>
                  <th>成交负责人</th>
                  <th>客户归属人</th>
                  <th>期次</th>
                  <th>payout 日期</th>
                  <th>比例</th>
                  <th>期金额</th>
                  <th>各参与人分摊</th>
                  <th>payout 状态</th>
                  {canUpdate && batch.status === "draft" && <th style={{ width: 80 }}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={canUpdate && batch.status === "draft" ? 12 : 11} className="empty-cell">
                      暂无明细
                    </td>
                  </tr>
                )}
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className={item.stale ? "row-disabled" : undefined}
                    title={item.stale ? "底层 payout 已被修改或置为已发，本条为历史/失效数据" : undefined}
                  >
                    <td>
                      <span className="cell-stack">
                        <span>{epochMsToDate(item.dealDate)}</span>
                        <span className="cell-sub">{item.dealMonth}</span>
                      </span>
                    </td>
                    <td>{item.customer ? item.customer.nickname : "—"}</td>
                    <td>{item.product ? item.product.name : "—"}</td>
                    <td>{item.owner ? item.owner.nickname : "—"}</td>
                    <td>{item.customerOwner ? item.customerOwner.nickname : "—"}</td>
                    <td>第{item.seq}期</td>
                    <td>{epochMsToDate(item.payoutDate)}</td>
                    <td>{percentText(item.rate)}</td>
                    <td>¥{centsToYuan(item.payoutAmountCents)}</td>
                    <td>{sharesText(item)}</td>
                    <td>
                      {payoutStatusBadge(item.payoutStatus)}
                      {item.stale && <span className="cell-sub">已失效</span>}
                    </td>
                    {canUpdate && batch.status === "draft" && (
                      <td>
                        <button type="button" onClick={() => setRemoving(item)}>
                          移除
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {adding && (
        <AddItemsModal batchId={batchId} busy={busy} onClose={() => setAdding(false)} onSubmit={addItems} />
      )}
      {confirm && (
        <ConfirmDialog
          message={confirmMessage}
          loading={busy}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          message={`确定把「${removing.customer?.nickname ?? `#${removing.dealId}`} 第${removing.seq}期」从本批次移除？`}
          loading={busy}
          onConfirm={() => void removeItem()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}
