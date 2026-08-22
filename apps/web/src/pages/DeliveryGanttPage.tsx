// 交付单详情 → 甘特图页（项目维度交付项，K44 增强）：
// - 时间轴天粒度展示已排期（startsAt+endsAt 均非空）项目交付项条块；时间轴固定按交付单周期；
// - 行内编辑起止日期（change 即 PATCH，updatedAt OCC）；
// - 新增（项目维度）/ 删除直接在本页维护；下方按开始时间排序列出全部项目交付项（todo 风格）；
// - assistant 只读（无编辑控件）。纯 CSS 网格实现，不引第三方甘特库。
import { useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { can } from "@gb-crm/shared";
import { useNavigate, useParams } from "react-router-dom";

import { api, ApiError } from "../api/client";
import type { DeliverableDto, DeliveryDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { dateToEpochMs, epochMsToDate } from "../columns/common";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";

const DAY_MS = 86_400_000;
const COL_W = 28; // 每列（天）像素宽

/** 起止日期行内编辑（change 即 PATCH，updatedAt OCC）；只读时展示日期文本 */
function DateRangeInputs({ item, canUpdate, onPatchDates }: { item: DeliverableDto; canUpdate: boolean; onPatchDates: (item: DeliverableDto, patch: Record<string, unknown>) => void }) {
  if (!canUpdate) {
    return (
      <div className="gantt-item-meta">
        {item.startsAt ? epochMsToDate(item.startsAt) : "—"} ~ {item.endsAt ? epochMsToDate(item.endsAt) : "—"}
      </div>
    );
  }
  return (
    <div className="gantt-item-dates">
      <input
        type="date"
        aria-label={`${item.content} 开始日期`}
        autoComplete="off"
        value={epochMsToDate(item.startsAt)}
        onChange={(e) => {
          const ms = dateToEpochMs(e.target.value);
          if (ms === item.startsAt) return;
          onPatchDates(item, { startsAt: ms });
        }}
      />
      <span>—</span>
      <input
        type="date"
        aria-label={`${item.content} 结束日期`}
        autoComplete="off"
        value={epochMsToDate(item.endsAt)}
        onChange={(e) => {
          const ms = dateToEpochMs(e.target.value);
          if (ms === item.endsAt) return;
          onPatchDates(item, { endsAt: ms });
        }}
      />
    </div>
  );
}

interface GanttItemProps {
  item: DeliverableDto;
  rangeStart: number;
  rangeDays: number;
  canUpdate: boolean;
  onPatchDates: (item: DeliverableDto, patch: Record<string, unknown>) => void;
  onDelete: (item: DeliverableDto) => void;
}

/** 时间轴行：左标签列 + 右侧天网格（条块绝对定位，轴外部分由 track 裁剪） */
function GanttItemRow({ item, rangeStart, rangeDays, canUpdate, onPatchDates, onDelete }: GanttItemProps) {
  const done = item.tasks.filter((t) => t.done).length;
  const total = item.tasks.length;
  const scheduled = item.startsAt != null && item.endsAt != null;
  const bar =
    scheduled && item.endsAt! >= item.startsAt!
      ? {
          left: ((item.startsAt! - rangeStart) / DAY_MS) * COL_W,
          width: ((item.endsAt! - item.startsAt!) / DAY_MS) * COL_W + COL_W,
        }
      : null;
  const hint = [item.description, item.deliveryUrl, total > 0 ? `进度 ${done}/${total}` : ""]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="gantt-row">
      <div className="gantt-row-label">
        <div className="gantt-item-title" title={hint || undefined}>
          {item.content}
        </div>
        <DateRangeInputs item={item} canUpdate={canUpdate} onPatchDates={onPatchDates} />
        <div className="gantt-item-meta">
          {total > 0 ? `进度 ${done}/${total}` : "无动作"}
        </div>
        {canUpdate && (
          <button
            type="button"
            className="btn-danger gantt-item-delete"
            aria-label={`删除 ${item.content}`}
            onClick={() => onDelete(item)}
          >
            删除
          </button>
        )}
      </div>
      <div className="gantt-track" style={{ width: rangeDays * COL_W }}>
        {bar && (
          <div
            className="gantt-bar"
            style={{ left: bar.left, width: bar.width }}
            title={hint || undefined}
            aria-label={`${item.content} 排期条`}
          >
            {item.content}
          </div>
        )}
      </div>
    </div>
  );
}

/** todo 行：全部项目交付项只读清单（按开始时间排序）——标题 + 进度 + 日期/未排期 */
function ProjectTodoRow({ item }: { item: DeliverableDto }) {
  const done = item.tasks.filter((t) => t.done).length;
  const total = item.tasks.length;
  const scheduled = item.startsAt != null && item.endsAt != null;

  return (
    <div className="gantt-todo-row" role="listitem">
      <span className={`gantt-todo-dot ${total > 0 && done === total ? "gantt-todo-done" : ""}`} />
      <div className="gantt-todo-main">
        <div className="gantt-todo-title">{item.content}</div>
        <div className="gantt-todo-meta">{total > 0 ? `进度 ${done}/${total}` : "无动作"}</div>
      </div>
      <div className={`gantt-todo-meta ${scheduled ? "" : "gantt-todo-unscheduled"}`}>
        {scheduled ? `${epochMsToDate(item.startsAt)} ~ ${epochMsToDate(item.endsAt)}` : "未排期"}
      </div>
    </div>
  );
}

interface GanttItemFormModalProps {
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

/** 新增项目交付项：标题必填 + 起止日期可选 + 说明/链接 */
function GanttItemFormModal({ busy, onClose, onSubmit }: GanttItemFormModalProps) {
  const showToast = useToast();
  const [content, setContent] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [description, setDescription] = useState("");
  const [deliveryUrl, setDeliveryUrl] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim()) {
      showToast("请填写交付项标题");
      return;
    }
    void onSubmit({
      content: content.trim(),
      dimension: "project",
      startsAt: dateToEpochMs(startsAt),
      endsAt: dateToEpochMs(endsAt),
      description: description.trim() || null,
      deliveryUrl: deliveryUrl.trim() || null,
    });
  };

  return (
    <Modal title="新增项目交付项" onClose={onClose} form>
      <form className="form-grid" onSubmit={submit}>
        <label className="field">
          交付项标题
          <input autoComplete="off" value={content} onChange={(e) => setContent(e.target.value)} placeholder="如：拉群 / 圈子全年交付" />
        </label>
        <label className="field">
          开始日期
          <input type="date" autoComplete="off" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </label>
        <label className="field">
          结束日期
          <input type="date" autoComplete="off" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
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

export function DeliveryGanttPage() {
  const { id } = useParams();
  const deliveryId = Number(id);
  const { me } = useAuth();
  const role = me?.systemRole ?? null;
  const showToast = useToast();
  const navigate = useNavigate();
  const canUpdate = can(role, "deliveries", "update");

  const { data: delivery } = useQuery({
    queryKey: ["deliveries", deliveryId],
    queryFn: async () => (await api.get<{ data: DeliveryDto }>(`/deliveries/${deliveryId}`))?.data,
  });
  const { data: items, refetch } = useQuery({
    queryKey: ["deliveries", deliveryId, "items"],
    queryFn: async () =>
      (await api.get<{ data: DeliverableDto[] }>(`/deliveries/${deliveryId}/items`))?.data ?? [],
  });

  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<DeliverableDto | null>(null);
  const [busy, setBusy] = useState(false);

  const projectItems = useMemo(() => (items ?? []).filter((i) => i.dimension === "project"), [items]);
  const scheduled = projectItems.filter((i) => i.startsAt != null && i.endsAt != null);
  const unscheduled = projectItems.filter((i) => i.startsAt == null || i.endsAt == null);
  // todo 清单：全部项目交付项按开始时间升序（未排期排最后）
  const sortedProjectItems = useMemo(
    () => [...projectItems].sort((a, b) => (a.startsAt ?? Infinity) - (b.startsAt ?? Infinity)),
    [projectItems],
  );

  // 时间范围：优先固定为交付单周期（startsAt ~ endsAt），不随交付项排期外扩；
  // 交付单两端都缺时退而依赖交付项范围；仍缺 → 当前月；缺一端 → 对端 ± 30 天。
  const range = useMemo(() => {
    const dStart = delivery?.startsAt ?? null;
    const dEnd = delivery?.endsAt ?? null;
    const itemStarts = scheduled.map((i) => i.startsAt as number);
    const itemEnds = scheduled.map((i) => i.endsAt as number);
    let start: number;
    let end: number;
    if (dStart !== null && dEnd !== null) {
      start = dStart;
      end = dEnd;
    } else {
      const s = dStart ?? (itemStarts.length > 0 ? Math.min(...itemStarts) : null);
      const e = dEnd ?? (itemEnds.length > 0 ? Math.max(...itemEnds) : null);
      if (s !== null && e !== null) {
        start = s;
        end = e;
      } else if (s === null && e === null) {
        const now = new Date();
        start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        end = new Date(now.getFullYear(), now.getMonth() + 1, 0).getTime();
      } else if (s === null) {
        start = e! - 30 * DAY_MS;
        end = e!;
      } else {
        start = s;
        end = s + 30 * DAY_MS;
      }
    }
    if (end < start) return null;
    return { start, end, days: Math.round((end - start) / DAY_MS) + 1 };
  }, [scheduled, delivery]);

  // 天列 + 月份表头 span
  const days = useMemo(() => {
    if (!range) return [];
    const list: { ts: number; date: number }[] = [];
    for (let t = range.start; t <= range.end; t += DAY_MS) {
      const d = new Date(t);
      list.push({ ts: t, date: d.getDate() });
    }
    return list;
  }, [range]);

  const monthSpans = useMemo(() => {
    const spans: { label: string; key: string; count: number }[] = [];
    for (const day of days) {
      const d = new Date(day.ts);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const label = `${d.getMonth() + 1}月`;
      const last = spans[spans.length - 1];
      if (last && last.key === key) last.count += 1;
      else spans.push({ label, key, count: 1 });
    }
    return spans;
  }, [days]);

  const patchDates = async (item: DeliverableDto, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.patch(`/deliveries/${deliveryId}/items/${item.id}`, { ...patch, updatedAt: item.updatedAt });
      await refetch();
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

  const createItem = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post(`/deliveries/${deliveryId}/items`, body);
      setCreating(false);
      await refetch();
      showToast("已创建交付项");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "创建失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.delete(`/deliveries/${deliveryId}/items/${deleting.id}`);
      setDeleting(null);
      await refetch();
      showToast("已删除");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const trackWidth = days.length * COL_W;

  return (
    <>
      <div className="page-head">
        <h1>甘特图 · {delivery?.deliveryType?.name ?? `交付 #${deliveryId}`}</h1>
        <div className="search-bar">
          <button type="button" onClick={() => navigate(`/deliveries/${deliveryId}`)}>
            返回详情
          </button>
          {canUpdate && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              新增项目交付项
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body-flush">
          {projectItems.length === 0 && (
            <div className="task-empty">暂无项目维度交付项（时间轴按交付周期展示）</div>
          )}
          {range && (
            <div className="gantt-scroll">
              <div className="gantt-head" style={{ minWidth: 280 + trackWidth }}>
                <div className="gantt-head-label">项目交付项</div>
                <div className="gantt-head-track" style={{ width: trackWidth }}>
                  <div className="gantt-months" style={{ gridTemplateColumns: monthSpans.map((m) => `${m.count * COL_W}px`).join(" ") }}>
                    {monthSpans.map((m) => (
                      <div className="gantt-month" key={m.key}>
                        {m.label}
                      </div>
                    ))}
                  </div>
                  <div className="gantt-days" style={{ gridTemplateColumns: `repeat(${days.length}, ${COL_W}px)` }}>
                    {days.map((d) => (
                      <div className="gantt-day" key={d.ts} title={epochMsToDate(d.ts)}>
                        {d.date}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {scheduled.map((item) => (
                <GanttItemRow
                  key={item.id}
                  item={item}
                  rangeStart={range!.start}
                  rangeDays={days.length}
                  canUpdate={canUpdate}
                  onPatchDates={(it, patch) => void patchDates(it, patch)}
                  onDelete={setDeleting}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>未排期（{unscheduled.length}）</h2>
          </div>
          <div className="card-body-flush">
            <div className="gantt-scroll">
              {unscheduled.map((item) => (
                <GanttItemRow
                  key={item.id}
                  item={item}
                  rangeStart={0}
                  rangeDays={0}
                  canUpdate={canUpdate}
                  onPatchDates={(it, patch) => void patchDates(it, patch)}
                  onDelete={setDeleting}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 全部项目交付项：按开始时间排序的只读 todo 清单（含未排期，排在末尾） */}
      <div className="card">
        <div className="card-head">
          <h2>全部项目交付项（{projectItems.length}）· 按开始时间</h2>
        </div>
        <div className="card-body-flush">
          {sortedProjectItems.length > 0 && (
            <div className="gantt-todo" role="list">
              {sortedProjectItems.map((item) => (
                <ProjectTodoRow key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <GanttItemFormModal busy={busy} onClose={() => setCreating(false)} onSubmit={createItem} />
      )}
      {deleting && (
        <ConfirmDialog
          title="删除交付项"
          message={`确定删除交付项「${deleting.content}」吗？删除后不在列表显示。`}
          confirmText="删除"
          loading={busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </>
  );
}
