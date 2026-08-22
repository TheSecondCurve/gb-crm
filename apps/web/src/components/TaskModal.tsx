import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { api, ApiError } from "../api/client";
import type { DeliverableDto, DeliveryTaskDto } from "../api/types";
import { formatDateTime } from "../columns/common";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface TaskModalProps {
  deliverable: DeliverableDto;
  onClose: () => void;
  /** 打勾/新增/删除后回调（父层刷新列表，进度列联动） */
  onChange: () => Promise<void> | void;
}

/** 交付项动作打勾清单弹窗：checkbox 即时 PATCH（带任务 updatedAt 行级 OCC）、新增/删除。 */
export function TaskModal({ deliverable, onClose, onChange }: TaskModalProps) {
  const showToast = useToast();
  const [tasks, setTasks] = useState<DeliveryTaskDto[]>(deliverable.tasks);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 父层行数据更新时（如 409 后整行替换）同步任务列表
  useEffect(() => {
    setTasks(deliverable.tasks);
  }, [deliverable]);

  const patchTask = useCallback(
    async (task: DeliveryTaskDto, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await api.patch<{ data: DeliveryTaskDto }>(
          `/deliverables/${deliverable.id}/tasks/${task.id}`,
          { ...body, updatedAt: task.updatedAt },
        );
        const fresh = res!.data;
        setTasks((prev) => prev.map((t) => (t.id === fresh.id ? fresh : t)));
        if (body.done === true && fresh.done && !task.done) {
          const allDone = tasks.every((t) => t.id === fresh.id || t.done);
          if (allDone) showToast("动作全部完成");
        }
        await onChange();
      } catch (err) {
        showToast(err instanceof ApiError && err.status === 409 ? "动作已被他人更新，请关闭后重试" : err instanceof Error ? err.message : "保存失败，请稍后重试");
      } finally {
        setBusy(false);
      }
    },
    [deliverable.id, onChange, showToast, tasks],
  );

  const addTask = async (e: FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setBusy(true);
    try {
      const res = await api.post<{ data: DeliveryTaskDto }>(
        `/deliverables/${deliverable.id}/tasks`,
        { content },
      );
      setTasks((prev) => [...prev, res!.data]);
      setDraft("");
      inputRef.current?.focus();
      await onChange();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "添加失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (task: DeliveryTaskDto) => {
    setBusy(true);
    try {
      await api.delete(`/deliverables/${deliverable.id}/tasks/${task.id}`);
      setTasks((prev) => prev.filter((t) => t.id !== task.id));
      await onChange();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`动作清单：${deliverable.deal?.customer?.nickname ?? `#${deliverable.id}`}`} wide onClose={onClose}>
      <div className="task-list">
        {tasks.length === 0 && <div className="task-empty">暂无动作，添加第一条开始跟踪交付。</div>}
        {tasks.map((task) => (
          <div className="task-row" key={task.id}>
            <label className="inline-field">
              <input
                type="checkbox"
                checked={task.done}
                disabled={busy}
                onChange={() => void patchTask(task, { done: !task.done })}
              />
              <span className={task.done ? "task-done" : ""}>{task.content}</span>
            </label>
            {task.done && task.doneBy && (
              <span className="task-meta">
                {task.doneBy.nickname} {formatDateTime(task.doneAt)}
              </span>
            )}
            <button
              type="button"
              className="btn-danger task-remove"
              disabled={busy}
              onClick={() => void removeTask(task)}
            >
              删除
            </button>
          </div>
        ))}
        <form className="task-add" onSubmit={(e) => void addTask(e)}>
          <input
            ref={inputRef}
            autoComplete="off"
            placeholder="新动作，如：拉群"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={busy}>
            添加
          </button>
        </form>
      </div>
    </Modal>
  );
}
