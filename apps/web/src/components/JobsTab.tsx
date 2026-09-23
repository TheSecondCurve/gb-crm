// 后台任务面板（K51，系统设置页 tab）：任务列表（状态/进度/触发/创建人）+ 详情 + 取消 + 新建任务（admin/operator）。
// 有 queued/running 任务时 3s 轮询刷新，全部结束后停止轮询。
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListEnvelope } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import type { BackgroundJobDto, JobFailureDto } from "../api/types";
import { badge, formatDateTime, type BadgeTone } from "../columns/common";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

const STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  succeeded: "成功",
  partial: "部分失败",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_TONES: Record<string, BadgeTone> = {
  queued: "muted",
  running: "accent",
  succeeded: "plain",
  partial: "danger",
  failed: "danger",
  cancelled: "muted",
};

const TRIGGER_LABELS: Record<string, string> = { manual: "手动", scheduled: "定时" };

const isActive = (status: string) => status === "queued" || status === "running";

function durationMs(job: BackgroundJobDto): number | null {
  if (job.startedAt === null || job.finishedAt === null) return null;
  return Math.max(0, job.finishedAt - job.startedAt);
}

function failuresOf(job: BackgroundJobDto): JobFailureDto[] {
  const failures = job.result?.failures;
  return Array.isArray(failures) ? (failures as JobFailureDto[]) : [];
}

export function JobsTab() {
  const showToast = useToast();
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [detail, setDetail] = useState<BackgroundJobDto | null>(null);
  const [cancelling, setCancelling] = useState<BackgroundJobDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["jobs", statusFilter],
    queryFn: async () =>
      (await api.get<ListEnvelope<BackgroundJobDto>>(
        `/background-jobs?pageSize=50${statusFilter ? `&status=${statusFilter}` : ""}`,
      )) ?? { data: [], meta: { page: 1, pageSize: 50, total: 0 } },
    // 有活跃任务时轮询，结束后自动停止
    refetchInterval: (query) => {
      const rows = (query.state.data as ListEnvelope<BackgroundJobDto> | undefined)?.data;
      return rows?.some((j) => isActive(j.status)) ? 3000 : false;
    },
  });

  const jobs = data?.data ?? [];

  const cancel = async (job: BackgroundJobDto) => {
    setBusy(true);
    try {
      await api.post(`/background-jobs/${job.id}/cancel`);
      setCancelling(null);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      showToast("任务已取消");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "取消失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: number) => {
    try {
      const res = await api.get<{ data: BackgroundJobDto }>(`/background-jobs/${id}`);
      setDetail(res?.data ?? null);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "加载任务详情失败");
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>后台任务</h2>
        <div style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
          {me?.systemRole !== "assistant" && (
            <button type="button" className="ghost-btn" onClick={() => setCreating(true)}>
              新建任务
            </button>
          )}
          <select
            aria-label="任务状态筛选"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="card-body-flush">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>类型</th>
              <th>状态</th>
              <th>进度</th>
              <th>成功/失败</th>
              <th>触发</th>
              <th>创建人</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={9} className="task-empty">
                  暂无后台任务
                </td>
              </tr>
            )}
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>#{job.id}</td>
                <td>{job.typeLabel ?? job.type}</td>
                <td>{badge(STATUS_LABELS[job.status] ?? job.status, STATUS_TONES[job.status] ?? "muted")}</td>
                <td>
                  {job.status === "queued"
                    ? "排队中"
                    : `${job.progress.processed}/${job.progress.total}`}
                </td>
                <td>
                  {job.status === "succeeded" || job.status === "partial" || job.status === "failed"
                    ? `${job.progress.succeeded} / ${job.progress.failed}`
                    : "—"}
                </td>
                <td>{TRIGGER_LABELS[job.trigger] ?? job.trigger}</td>
                <td>{job.createdBy?.nickname ?? "—"}</td>
                <td>{formatDateTime(job.createdAt)}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => void openDetail(job.id)}>
                    详情
                  </button>
                  {isActive(job.status) && (
                    <button type="button" className="btn-danger" onClick={() => setCancelling(job)}>
                      取消
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && <JobDetailModal job={detail} busy={busy} onClose={() => setDetail(null)} onCancel={() => setCancelling(detail)} />}
      {creating && <CreateJobModal onClose={() => setCreating(false)} />}
      {cancelling && (
        <ConfirmDialog
          title="取消任务"
          message={`确定取消任务「${cancelling.typeLabel ?? cancelling.type} #${cancelling.id}」吗？已处理的客户标签会保留。`}
          confirmText="取消任务"
          loading={busy}
          onConfirm={() => void cancel(cancelling)}
          onCancel={() => setCancelling(null)}
        />
      )}
    </div>
  );
}

/** 新建任务：类型下拉（JOB_TYPES 注册表）+ params JSON；服务端按类型 schema 校验（非法 422 中文明细） */
function CreateJobModal({ onClose }: { onClose: () => void }) {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const { data: types } = useQuery({
    queryKey: ["jobs", "types"],
    queryFn: async () =>
      (await api.get<{ data: { type: string; label: string }[] }>("/background-jobs/types"))?.data ?? [],
    staleTime: 5 * 60_000,
  });
  const [type, setType] = useState("");
  const [paramsText, setParamsText] = useState("{}");
  const [busy, setBusy] = useState(false);

  const create = useMutation({
    mutationFn: async (body: { type: string; params: Record<string, unknown> }) => {
      const res = await api.post<{ data: BackgroundJobDto }>("/background-jobs", body);
      return res?.data;
    },
    onSuccess: (job) => {
      showToast(`任务已创建：${job?.typeLabel ?? job?.type ?? ""} #${job?.id ?? ""}，排队执行中`);
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试"),
  });

  const submit = () => {
    const selected = type || types?.[0]?.type || "";
    if (!selected) {
      showToast("请选择任务类型");
      return;
    }
    let params: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(paramsText.trim() || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not object");
      }
      params = parsed as Record<string, unknown>;
    } catch {
      showToast("params 必须是合法的 JSON 对象，如 {\"all\": true}");
      return;
    }
    setBusy(true);
    create.mutate({ type: selected, params }, { onSettled: () => setBusy(false) });
  };

  return (
    <Modal title="新建后台任务" onClose={onClose}>
      <div className="form-grid">
        <label className="field">
          任务类型
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="任务类型">
            <option value="">选择任务类型…</option>
            {(types ?? []).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          参数（JSON 对象，按任务类型校验）
          <textarea
            aria-label="任务参数 JSON"
            rows={4}
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            placeholder='例如客户信号抽取全量回填填 {"all": true}；留空 {} 为默认模式'
            spellCheck={false}
          />
        </label>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)" }}>
          提示：「客户信号抽取」填 {"{"}"all": true{"}"} 全量回填；留空只扫有新记录的客户（夜间兜底同此模式）。
        </p>
      </div>
      <div className="modal-actions">
        <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy || create.isPending}>
          创建任务
        </button>
      </div>
    </Modal>
  );
}

interface JobDetailModalProps {
  job: BackgroundJobDto;
  busy: boolean;
  onClose: () => void;
  onCancel: () => void;
}

function JobDetailModal({ job, busy, onClose, onCancel }: JobDetailModalProps) {
  const progress = job.progress;
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const failures = failuresOf(job);
  const cost = durationMs(job);

  return (
    <Modal title={`任务详情 #${job.id} · ${job.typeLabel ?? job.type}`} wide onClose={onClose}>
      <div className="job-detail-meta">
        <span className="detail-label">状态</span>
        <span>{badge(STATUS_LABELS[job.status] ?? job.status, STATUS_TONES[job.status] ?? "muted")}</span>
        <span className="detail-label">进度</span>
        <span>
          <span className="progress-track">
            <span className="progress-fill" style={{ width: `${pct}%` }} />
          </span>{" "}
          {progress.processed}/{progress.total}
        </span>
        <span className="detail-label">成功/失败</span>
        <span>
          {progress.succeeded} / {progress.failed}
        </span>
        <span className="detail-label">触发</span>
        <span>{TRIGGER_LABELS[job.trigger] ?? job.trigger}</span>
        {job.triggerSpec && (
          <>
            <span className="detail-label">cron</span>
            <span>
              <code>{job.triggerSpec}</code>
            </span>
          </>
        )}
        <span className="detail-label">创建人</span>
        <span>{job.createdBy?.nickname ?? "—"}</span>
        <span className="detail-label">创建时间</span>
        <span>{formatDateTime(job.createdAt)}</span>
        <span className="detail-label">开始时间</span>
        <span>{formatDateTime(job.startedAt) || "—"}</span>
        <span className="detail-label">结束时间</span>
        <span>{formatDateTime(job.finishedAt) || "—"}</span>
        <span className="detail-label">耗时</span>
        <span>{cost !== null ? `${(cost / 1000).toFixed(1)}s` : "—"}</span>
      </div>

      {job.error && (
        <p className="confirm-text" style={{ color: "var(--accent)" }}>
          {job.error}
        </p>
      )}

      {failures.length > 0 && (
        <>
          <h3 style={{ margin: "12px 0 6px", fontSize: 13 }}>失败明细（{failures.length}）</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>客户</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.customerId}>
                  <td>{f.nickname}</td>
                  <td>{f.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="modal-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          关闭
        </button>
        {isActive(job.status) && (
          <button type="button" className="btn-danger" onClick={onCancel} disabled={busy}>
            取消任务
          </button>
        )}
      </div>
    </Modal>
  );
}
