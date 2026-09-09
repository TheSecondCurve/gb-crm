import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { can, payoutBatchStatusLabels } from "@gb-crm/shared";

import { api, ApiError, buildQuery } from "../api/client";
import type { PayoutBatchDetailDto, PayoutBatchRowDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  centsToYuan,
  dateToEpochMs,
  enumBadge,
  epochMsToDate,
  formatDateTime,
  type BadgeTone,
} from "../columns/common";
import { Pagination } from "../components/DataGrid/DataGrid";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

const DAY_TAIL_MS = 86399999; // 当日 23:59:59.999（结束日期含当天，与 DealFilterBar 同口径）

const BATCH_TONES: Record<string, BadgeTone> = {
  draft: "muted",
  locked: "plain",
  paid: "accent",
};
const batchBadge = enumBadge(payoutBatchStatusLabels, BATCH_TONES);

type ConfirmState =
  | { kind: "delete"; row: PayoutBatchRowDto }
  | { kind: "markPaid"; row: PayoutBatchRowDto }
  | { kind: "unlock"; row: PayoutBatchRowDto };

/** 新建批次弹窗：名称可空（服务端缺省自动生成）+ 起止日期（本地零点 epoch ms，止含当天） */
function PayoutBatchCreateModal({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const showToast = useToast();
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const start = dateToEpochMs(startDate);
    const end = dateToEpochMs(endDate);
    if (start === null || end === null) {
      showToast("请选择起止日期");
      return;
    }
    void onSubmit({
      name: name.trim() || undefined,
      startDate: start,
      endDate: end + DAY_TAIL_MS,
    });
  };

  return (
    <Modal title="新建发放批次" onClose={onClose}>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="field field-span">
          批次名
          <input
            autoComplete="off"
            placeholder="可空，缺省自动生成「发放 YYYY-MM-DD~YYYY-MM-DD」"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          开始日期
          <input
            type="date"
            aria-label="开始日期"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label className="field">
          结束日期
          <input
            type="date"
            aria-label="结束日期"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>
        <p className="cell-sub field-span" style={{ margin: 0 }}>
          创建后自动纳入范围内全部待发 payout；已锁定/发放前仍可增删明细。
        </p>
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

/** K59 分成发放：payout 结算批次列表 */
export function PayoutBatchesPage() {
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const canUpdate = can(role, "dealCommissions", "update");
  const showToast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["payout-batches", page, pageSize, status],
    queryFn: async () =>
      (await api.get<{ data: PayoutBatchRowDto[]; meta: { total: number } }>(
        `/payout-batches${buildQuery({ page, pageSize, status })}`,
      )) ?? { data: [], meta: { total: 0 } },
  });

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["payout-batches"] });

  const createBatch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await api.post<{ data: PayoutBatchDetailDto }>("/payout-batches", body);
      setCreating(false);
      await invalidate();
      showToast("已创建发放批次");
      if (res?.data) navigate(`/deals/payout-batches/${res.data.batch.id}`);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "delete") {
        await api.delete(`/payout-batches/${confirm.row.id}`);
        showToast("已删除批次");
      } else if (confirm.kind === "markPaid") {
        const res = await api.post<{ data: PayoutBatchDetailDto; meta: { marked: number; skipped: number } }>(
          `/payout-batches/${confirm.row.id}/mark-paid`,
          {},
        );
        const meta = res?.meta;
        showToast(
          meta
            ? `已标记 ${meta.marked} 条为已发${meta.skipped > 0 ? `，跳过 ${meta.skipped} 条` : ""}`
            : "已标记已发",
        );
      } else {
        await api.post(`/payout-batches/${confirm.row.id}/unlock`, {});
        showToast("已解锁，回到草稿状态");
      }
      setConfirm(null);
      await invalidate();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (() => {
    if (!confirm) return "";
    switch (confirm.kind) {
      case "delete":
        return `确定删除批次「${confirm.row.name}」？批次的全部明细将一并移除，不可恢复。`;
      case "markPaid":
        return `确定把批次「${confirm.row.name}」标记为已发放？批次内全部待发 payout 将置为已发，操作不可撤销。`;
      case "unlock":
        return `确定解锁批次「${confirm.row.name}」？锁定时的金额与分摊快照将被清空，回到草稿状态。`;
    }
  })();

  const COLUMN_COUNT = 8;

  return (
    <>
      <div className="page-head">
        <h1>分成发放</h1>
        <div className="search-bar">
          <select
            aria-label="状态筛选"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(payoutBatchStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {canUpdate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新建批次
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body-flush">
          <div className="data-grid-scroll">
            <table className="data-table data-grid-table" aria-busy={isLoading}>
              <thead>
                <tr>
                  <th>批次名</th>
                  <th>日期范围</th>
                  <th>状态</th>
                  <th>明细数</th>
                  <th>总金额</th>
                  <th>创建人</th>
                  <th>创建时间</th>
                  <th style={{ width: 200 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={COLUMN_COUNT} className="empty-cell">
                      暂无发放批次
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/deals/payout-batches/${row.id}`}>{row.name}</Link>
                    </td>
                    <td>
                      {epochMsToDate(row.rangeStart)} ~ {epochMsToDate(row.rangeEnd)}
                    </td>
                    <td>{batchBadge(row.status)}</td>
                    <td>{row.itemCount}</td>
                    <td>¥{centsToYuan(row.totalAmountCents)}</td>
                    <td>{row.createdBy ? row.createdBy.nickname : "—"}</td>
                    <td>{formatDateTime(row.createdAt)}</td>
                    <td>
                      <span className="row-actions">
                        <a href={`/api/v1/payout-batches/${row.id}/export.xlsx`} download="">
                          导出
                        </a>
                        {canUpdate && row.status === "locked" && (
                          <>
                            <button
                              type="button"
                              onClick={() => setConfirm({ kind: "markPaid", row })}
                            >
                              标记已发
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirm({ kind: "unlock", row })}
                            >
                              解锁
                            </button>
                          </>
                        )}
                        {canUpdate && row.status === "draft" && (
                          <button
                            type="button"
                            onClick={() => setConfirm({ kind: "delete", row })}
                          >
                            删除
                          </button>
                        )}
                      </span>
                    </td>
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

      {creating && (
        <PayoutBatchCreateModal busy={busy} onClose={() => setCreating(false)} onSubmit={createBatch} />
      )}
      {confirm && (
        <ConfirmDialog
          message={confirmText}
          loading={busy}
          onConfirm={() => void runConfirm()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
