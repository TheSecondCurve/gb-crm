// 定时任务面板（K52，系统设置页 tab，仅 admin）：调度定义列表（类型/cron/启停/上次/下次运行）+ 创建/编辑/删除/立即执行。
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListEnvelope } from "@gb-crm/shared";

import { api, ApiError } from "../api/client";
import type { JobScheduleDto, JobScheduleTypeOptionDto } from "../api/types";
import { badge, formatDateTime } from "../columns/common";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface ScheduleForm {
  type: string;
  cron: string;
  params: string;
}

export function SchedulesTab() {
  const showToast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<JobScheduleDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<JobScheduleDto | null>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["job-schedules"],
    queryFn: async () =>
      (await api.get<ListEnvelope<JobScheduleDto>>("/job-schedules?pageSize=100")) ?? {
        data: [],
        meta: { page: 1, pageSize: 100, total: 0 },
      },
  });

  const schedules = data?.data ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["job-schedules"] });

  const toggle = async (s: JobScheduleDto) => {
    setBusy(true);
    try {
      await api.patch(`/job-schedules/${s.id}`, { enabled: !s.enabled });
      showToast(s.enabled ? "已停用定时任务" : "已启用定时任务");
      await invalidate();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "操作失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (s: JobScheduleDto) => {
    setBusy(true);
    try {
      await api.post(`/job-schedules/${s.id}/run`);
      showToast("已触发一次执行，请到「后台任务」查看进度");
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "触发失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/job-schedules/${deleting.id}`);
      setDeleting(null);
      showToast("已删除定时任务");
      await invalidate();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>定时任务</h2>
        <button type="button" className="btn-primary" onClick={() => setEditing("new")}>
          新建定时任务
        </button>
      </div>
      <div className="card-body-flush">
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>类型</th>
              <th>cron</th>
              <th>状态</th>
              <th>上次运行</th>
              <th>下次运行</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 && (
              <tr>
                <td colSpan={7} className="task-empty">
                  暂无定时任务（仅 admin 可配置）
                </td>
              </tr>
            )}
            {schedules.map((s) => (
              <tr key={s.id}>
                <td>#{s.id}</td>
                <td>{s.typeLabel ?? s.type}</td>
                <td>
                  <code>{s.cron}</code>
                </td>
                <td>
                  {badge(s.enabled ? "启用" : "停用", s.enabled ? "plain" : "muted")}
                </td>
                <td>{formatDateTime(s.lastRunAt) || "—"}</td>
                <td>{formatDateTime(s.nextRunAt) || "—"}</td>
                <td className="row-actions">
                  <button type="button" onClick={() => setEditing(s)}>
                    编辑
                  </button>
                  <button type="button" onClick={() => void runNow(s)} disabled={busy}>
                    立即执行
                  </button>
                  <button type="button" onClick={() => void toggle(s)} disabled={busy}>
                    {s.enabled ? "停用" : "启用"}
                  </button>
                  <button type="button" className="btn-danger" onClick={() => setDeleting(s)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        <ScheduleModal
          schedule={editing === "new" ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void invalidate();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除定时任务"
          message={`确定删除定时任务「${deleting.typeLabel ?? deleting.type} #${deleting.id}」？删除后不会触发新任务。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function ScheduleModal({
  schedule,
  busy,
  onClose,
  onSaved,
}: {
  schedule: JobScheduleDto | null;
  busy: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const showToast = useToast();
  const { data: types } = useQuery({
    queryKey: ["job-schedules", "types"],
    queryFn: async () =>
      (await api.get<{ data: JobScheduleTypeOptionDto[] }>("/job-schedules/types"))?.data ?? [],
  });

  const [form, setForm] = useState<ScheduleForm>({
    type: schedule?.type ?? "",
    cron: schedule?.cron ?? "",
    params: JSON.stringify(schedule?.params ?? {}, null, 2),
  });

  // 首次打开时默认选中第一个可调度类型
  useEffect(() => {
    setForm((f) => {
      if (f.type !== "" || !types || types.length === 0) return f;
      return { ...f, type: types[0]!.type };
    });
  }, [types]);

  const save = async () => {
    let params: Record<string, unknown> = {};
    if (form.params.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(form.params);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("json");
        params = parsed as Record<string, unknown>;
      } catch {
        showToast("任务参数需为合法 JSON 对象（如 {}）");
        return;
      }
    }
    try {
      if (schedule) {
        const body: Record<string, unknown> = {};
        if (form.cron.trim() !== schedule.cron) body.cron = form.cron.trim();
        if (form.type !== schedule.type) body.type = form.type;
        if (JSON.stringify(params) !== JSON.stringify(schedule.params)) body.params = params;
        await api.patch(`/job-schedules/${schedule.id}`, body);
        showToast("已保存定时任务");
      } else {
        await api.post("/job-schedules", { type: form.type, cron: form.cron.trim(), params });
        showToast("已创建定时任务");
      }
      onSaved();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "保存失败，请稍后重试");
    }
  };

  return (
    <Modal title={schedule ? `编辑定时任务 #${schedule.id}` : "新建定时任务"} onClose={onClose}>
      <div className="settings-form">
        <label className="field">
          任务类型
          <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
            <option value="" disabled>
              选择任务类型
            </option>
            {(types ?? []).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          cron 表达式（分 时 日 月 周，按服务器时区求值）
          <input
            autoComplete="off"
            placeholder="如 0 2 * * *（每天 02:00）"
            value={form.cron}
            onChange={(e) => setForm((f) => ({ ...f, cron: e.target.value }))}
          />
        </label>
        <label className="field">
          任务参数（JSON；批量打标 = 客户筛选子集）
          <textarea
            rows={4}
            value={form.params}
            onChange={(e) => setForm((f) => ({ ...f, params: e.target.value }))}
            style={{ fontFamily: "var(--font-mono, monospace)" }}
          />
        </label>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}
