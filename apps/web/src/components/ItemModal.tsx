import { useCallback, useEffect, useState, type FormEvent } from "react";

import { api, ApiError } from "../api/client";
import type { DeliverableDto, DeliveryTaskDto } from "../api/types";
import { formatDateTime } from "../columns/common";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

interface ItemModalProps {
  deliveryId: number;
  item: DeliverableDto;
  onClose: () => void;
  /** 打勾/备注/增删后回调（父层刷新） */
  onChange: () => Promise<void> | void;
}

interface TaskRowProps {
  task: DeliveryTaskDto;
  busy: boolean;
  onPatch: (task: DeliveryTaskDto, body: Record<string, unknown>) => Promise<void>;
  onDelete: (task: DeliveryTaskDto) => Promise<void>;
}

/** 单条动作行：打勾 + 文本 + 备注（blur 提交）+ 删除 */
function TaskRow({ task, busy, onPatch, onDelete }: TaskRowProps) {
  const [remark, setRemark] = useState(task.remark ?? "");
  const [savedRemark, setSavedRemark] = useState(task.remark ?? "");

  // 外部刷新（如 409 后）同步备注草稿
  useEffect(() => {
    setRemark(task.remark ?? "");
    setSavedRemark(task.remark ?? "");
  }, [task.remark]);

  const commitRemark = () => {
    const next = remark.trim();
    if (next === savedRemark) return;
    setSavedRemark(next);
    void onPatch(task, { remark: next === "" ? null : next });
  };

  return (
    <div className="task-row">
      <label className="inline-field task-check">
        <input
          type="checkbox"
          checked={task.done}
          disabled={busy}
          onChange={() => void onPatch(task, { done: !task.done })}
        />
        <span className={task.done ? "task-done" : ""}>{task.content}</span>
      </label>
      <input
        className="task-remark"
        placeholder="备注"
        autoComplete="off"
        value={remark}
        disabled={busy}
        onChange={(e) => setRemark(e.target.value)}
        onBlur={commitRemark}
      />
      {task.done && task.doneBy && (
        <span className="task-meta">
          {task.doneBy.nickname} {formatDateTime(task.doneAt)}
        </span>
      )}
      <button
        type="button"
        className="btn-danger task-remove"
        disabled={busy}
        onClick={() => void onDelete(task)}
      >
        删除
      </button>
    </div>
  );
}

interface TaskGroupProps {
  title?: string;
  customerId: number | null;
  tasks: DeliveryTaskDto[];
  busy: boolean;
  onPatch: (task: DeliveryTaskDto, body: Record<string, unknown>) => Promise<void>;
  onDelete: (task: DeliveryTaskDto) => Promise<void>;
  onAdd: (content: string, customerId: number | null) => Promise<void>;
}

/** 一组动作清单（项目维度 = 单组；客户维度 = 每客户一组） */
function TaskGroup({ title, customerId, tasks, busy, onPatch, onDelete, onAdd }: TaskGroupProps) {
  const [draft, setDraft] = useState("");

  const add = (e: FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    void onAdd(content, customerId);
  };

  return (
    <div className="task-group">
      {title && <div className="task-group-title">{title}</div>}
      <div className="task-list">
        {tasks.length === 0 && <div className="task-empty">暂无动作</div>}
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            busy={busy}
            onPatch={onPatch}
            onDelete={onDelete}
          />
        ))}
        <form className="task-add" onSubmit={add}>
          <input
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
    </div>
  );
}

/**
 * 交付项动作打勾弹窗（K44）：
 * - 项目维度：一份清单（customer NULL），打勾/备注/增删；
 * - 客户维度：按客户分组，每客户一组清单，操作互不干扰。
 * 打勾/备注即时 PATCH（任务 updatedAt 行级 OCC）。
 */
export function ItemModal({ deliveryId, item, onClose, onChange }: ItemModalProps) {
  const showToast = useToast();
  const [tasks, setTasks] = useState<DeliveryTaskDto[]>(item.tasks);
  const [busy, setBusy] = useState(false);

  // 父层整行刷新（如列表 refetch）时同步
  useEffect(() => {
    setTasks(item.tasks);
  }, [item]);

  const patchTask = useCallback(
    async (task: DeliveryTaskDto, body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await api.patch<{ data: DeliveryTaskDto }>(
          `/deliveries/${deliveryId}/items/${item.id}/tasks/${task.id}`,
          { ...body, updatedAt: task.updatedAt },
        );
        const fresh = res!.data;
        setTasks((prev) => prev.map((t) => (t.id === fresh.id ? fresh : t)));
        await onChange();
      } catch (err) {
        showToast(
          err instanceof ApiError && err.status === 409
            ? "动作已被他人更新，请关闭后重试"
            : err instanceof Error
              ? err.message
              : "保存失败，请稍后重试",
        );
      } finally {
        setBusy(false);
      }
    },
    [deliveryId, item.id, onChange, showToast],
  );

  const deleteTask = useCallback(
    async (task: DeliveryTaskDto) => {
      setBusy(true);
      try {
        await api.delete(`/deliveries/${deliveryId}/items/${item.id}/tasks/${task.id}`);
        setTasks((prev) => prev.filter((t) => t.id !== task.id));
        await onChange();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "删除失败，请稍后重试");
      } finally {
        setBusy(false);
      }
    },
    [deliveryId, item.id, onChange, showToast],
  );

  const addTask = useCallback(
    async (content: string, customerId: number | null) => {
      setBusy(true);
      try {
        const res = await api.post<{ data: DeliveryTaskDto }>(
          `/deliveries/${deliveryId}/items/${item.id}/tasks`,
          { content, ...(customerId === null ? {} : { customerId }) },
        );
        setTasks((prev) => [...prev, res!.data]);
        await onChange();
      } catch (err) {
        showToast(err instanceof ApiError ? err.message : "添加失败，请稍后重试");
      } finally {
        setBusy(false);
      }
    },
    [deliveryId, item.id, onChange, showToast],
  );

  // 客户维度：按客户分组（保留交付单客户顺序由任务顺序近似，按 customer id 分组）
  const groups = item.dimension === "customer" ? groupByCustomer(tasks) : [{ customerId: null as number | null, tasks }];

  return (
    <Modal title={`动作清单：${item.content}`} wide onClose={onClose}>
      {item.dimension === "customer" && (
        <div className="task-empty-info">客户维度：每个客户分别打勾 / 备注</div>
      )}
      <div className="task-groups">
        {groups.map((g) => (
          <TaskGroup
            key={g.customerId ?? "project"}
            title={g.customerId === null ? undefined : g.customerName}
            customerId={g.customerId}
            tasks={g.tasks}
            busy={busy}
            onPatch={patchTask}
            onDelete={deleteTask}
            onAdd={addTask}
          />
        ))}
      </div>
    </Modal>
  );
}

function groupByCustomer(tasks: DeliveryTaskDto[]): { customerId: number | null; customerName?: string; tasks: DeliveryTaskDto[] }[] {
  const map = new Map<number, { customerId: number; customerName: string; tasks: DeliveryTaskDto[] }>();
  for (const t of tasks) {
    const cid = t.customer?.id ?? 0;
    const entry = map.get(cid) ?? {
      customerId: cid,
      customerName: t.customer?.nickname ?? `#${cid}`,
      tasks: [],
    };
    entry.tasks.push(t);
    map.set(cid, entry);
  }
  return [...map.values()];
}
