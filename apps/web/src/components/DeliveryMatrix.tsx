// 交付状态矩阵（客户维度交付项，K44 增强）：圈子工作台弹窗 / 矩阵页共用核心组件。
// - 行 = 交付单客户，列 = 客户维度交付项；格 = 该客户该交付项的任务状态；
// - 三态：未完成 / 完成（✓）/ 备注（角标，hover 气泡展示完整文字）；
// - 单击格切换完成（PATCH task done，updatedAt OCC）；双击格内联编辑备注（blur 提交）；
// - 无任务记录（如后加入交付单的客户）= 未完成，点击 = 创建并标记完成；assistant 只读。
// 数据由父级通过 props 传入（页面各自持有 useQuery），变更后回调 onChanged 重新拉取。
import { useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../api/client";
import type { DeliverableDto, DeliveryTaskDto } from "../api/types";
import { useToast } from "./Toast";

export interface DeliveryMatrixProps {
  deliveryId: number;
  /** 行 = 交付单当前客户集合 */
  customers: { id: number; nickname: string }[];
  /** 全部交付项（内部过滤 dimension === "customer"）；undefined = 加载中不渲染 */
  items: DeliverableDto[] | undefined;
  canUpdate: boolean;
  /** 写操作成功后回调（父级 refetch） */
  onChanged?: () => void;
}

interface MatrixCellProps {
  item: DeliverableDto;
  task: DeliveryTaskDto | undefined;
  /** 客户昵称（无障碍 label：`客户 · 交付项`） */
  customerName: string;
  customerId: number;
  canUpdate: boolean;
  onToggle: (item: DeliverableDto, task: DeliveryTaskDto) => void;
  onRemark: (item: DeliverableDto, task: DeliveryTaskDto, remark: string | null) => void;
  /** 无任务记录格：创建该客户的任务并标记完成 */
  onCreateAndDone: (item: DeliverableDto, customerId: number) => void;
}

/** 单元格：单击打勾（延迟 250ms 区分双击）/ 双击编辑备注 / 备注 hover 气泡 */
function MatrixCell({ item, task, customerName, customerId, canUpdate, onToggle, onRemark, onCreateAndDone }: MatrixCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task?.remark ?? "");
  const clickTimer = useRef<number | null>(null);

  useEffect(() => {
    setDraft(task?.remark ?? "");
  }, [task?.remark, task?.id]);

  if (!task) {
    // 无记录（如后加入交付单的客户）= 未完成；点击 = 创建任务并直接标记完成
    return (
      <td
        className="matrix-cell matrix-cell-empty"
        aria-label={`${customerName} · ${item.content}`}
        onClick={canUpdate ? () => onCreateAndDone(item, customerId) : undefined}
      >
        <span className="matrix-state">未完成</span>
      </td>
    );
  }

  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (next === (task.remark ?? "")) return;
      onRemark(item, task, next === "" ? null : next);
    };
    return (
      <td className="matrix-cell matrix-cell-editing">
        <input
          autoFocus
          autoComplete="off"
          placeholder="备注"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(task.remark ?? "");
              setEditing(false);
            }
          }}
        />
      </td>
    );
  }

  const enterEdit = () => {
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    if (canUpdate) setEditing(true);
  };

  return (
    <td
      className={`matrix-cell ${task.done ? "matrix-cell-done" : ""}`}
      aria-label={`${customerName} · ${item.content}`}
      data-remark={task.remark ?? undefined}
      onClick={() => {
        if (!canUpdate) return;
        if (clickTimer.current) window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => {
          clickTimer.current = null;
          onToggle(item, task);
        }, 250);
      }}
      onDoubleClick={enterEdit}
    >
      <span className="matrix-state">{task.done ? "✓ 完成" : "未完成"}</span>
      {task.remark && <span className="matrix-remark-badge">备注</span>}
    </td>
  );
}

export function DeliveryMatrix({ deliveryId, customers, items, canUpdate, onChanged }: DeliveryMatrixProps) {
  const showToast = useToast();

  const customerItems = useMemo(
    () => (items ?? []).filter((i) => i.dimension === "customer"),
    [items],
  );

  const patchTask = async (item: DeliverableDto, task: DeliveryTaskDto, body: Record<string, unknown>) => {
    try {
      await api.patch(`/deliveries/${deliveryId}/items/${item.id}/tasks/${task.id}`, {
        ...body,
        updatedAt: task.updatedAt,
      });
      onChanged?.();
    } catch (err) {
      showToast(
        err instanceof ApiError && err.status === 409
          ? "动作已被他人更新，请刷新后重试"
          : err instanceof ApiError
            ? err.message
            : "保存失败，请稍后重试",
      );
    }
  };

  const toggleTask = (item: DeliverableDto, task: DeliveryTaskDto) =>
    void patchTask(item, task, { done: !task.done });

  const saveRemark = (item: DeliverableDto, task: DeliveryTaskDto, remark: string | null) =>
    void patchTask(item, task, { remark });

  /** 无记录格：POST 创建该客户任务（内容=交付项标题），再 PATCH 标记完成（一步到位） */
  const createAndDone = async (item: DeliverableDto, customerId: number) => {
    try {
      const res = await api.post<{ data: DeliveryTaskDto }>(
        `/deliveries/${deliveryId}/items/${item.id}/tasks`,
        { content: item.content, customerId },
      );
      const task = res!.data;
      await api.patch(`/deliveries/${deliveryId}/items/${item.id}/tasks/${task.id}`, {
        done: true,
        updatedAt: task.updatedAt,
      });
      onChanged?.();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "操作失败，请稍后重试");
    }
  };

  const taskOf = (item: DeliverableDto, customerId: number): DeliveryTaskDto | undefined =>
    item.tasks.find((t) => t.customer?.id === customerId);

  const progressOf = (item: DeliverableDto): string => {
    const done = item.tasks.filter((t) => t.done).length;
    return `${done}/${item.tasks.length}`;
  };

  if (!items) return null;

  if (customerItems.length === 0) {
    return <div className="task-empty">暂无客户维度交付项</div>;
  }

  return (
    <div className="matrix-scroll">
      <table className="matrix-table">
        <thead>
          <tr>
            <th className="matrix-corner">
              客户 \ 交付项
              <span className="matrix-hint">单击打勾 · 双击备注</span>
            </th>
            {customerItems.map((item) => (
              <th key={item.id} title={item.description ?? undefined}>
                <div className="matrix-col-title">{item.content}</div>
                <div className="matrix-col-progress">{progressOf(item)}</div>
              </th>
            ))}
            <th className="matrix-corner">完成</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => {
            const doneCount = customerItems.filter((item) => taskOf(item, c.id)?.done).length;
            return (
              <tr key={c.id}>
                <th className="matrix-row-head">{c.nickname}</th>
                {customerItems.map((item) => (
                  <MatrixCell
                    key={item.id}
                    item={item}
                    task={taskOf(item, c.id)}
                    customerName={c.nickname}
                    customerId={c.id}
                    canUpdate={canUpdate}
                    onToggle={toggleTask}
                    onRemark={saveRemark}
                    onCreateAndDone={(it, customerId) => void createAndDone(it, customerId)}
                  />
                ))}
                <td className="matrix-row-sum">{doneCount}/{customerItems.length}</td>
              </tr>
            );
          })}
          {customers.length === 0 && (
            <tr>
              <td className="task-empty" colSpan={customerItems.length + 2}>
                该交付单暂无客户
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
