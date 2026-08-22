// 修改交付项弹窗（详情页 / 圈子工作台共用）：
// 标题 + （项目维度）起止日期 + 说明/链接；提交带 updatedAt OCC。
import { dateToEpochMs, epochMsToDate } from "../columns/common";
import type { DeliverableDto } from "../api/types";
import { Modal } from "./Modal";

interface ItemEditModalProps {
  item: DeliverableDto;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}

export function ItemEditModal({ item, busy, onClose, onSubmit }: ItemEditModalProps) {
  return (
    <Modal title={`修改交付项：${item.content}`} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const body: Record<string, unknown> = {
            content: (e.currentTarget.elements.namedItem("content") as HTMLInputElement).value.trim(),
            description: (e.currentTarget.elements.namedItem("description") as HTMLInputElement).value.trim() || null,
            deliveryUrl: (e.currentTarget.elements.namedItem("deliveryUrl") as HTMLInputElement).value.trim() || null,
            updatedAt: item.updatedAt,
          };
          // 项目维度交付项：起止日期（K44 甘特排期；客户维度不显示）
          if (item.dimension === "project") {
            body.startsAt = dateToEpochMs(
              (e.currentTarget.elements.namedItem("startsAt") as HTMLInputElement).value,
            );
            body.endsAt = dateToEpochMs(
              (e.currentTarget.elements.namedItem("endsAt") as HTMLInputElement).value,
            );
          }
          void onSubmit(body);
        }}
      >
        <label className="field">
          标题
          <input name="content" defaultValue={item.content} />
        </label>
        {item.dimension === "project" && (
          <>
            <label className="field">
              开始日期
              <input type="date" name="startsAt" autoComplete="off" defaultValue={epochMsToDate(item.startsAt)} />
            </label>
            <label className="field">
              结束日期
              <input type="date" name="endsAt" autoComplete="off" defaultValue={epochMsToDate(item.endsAt)} />
            </label>
          </>
        )}
        <label className="field field-span">
          交付说明
          <textarea name="description" rows={2} defaultValue={item.description ?? ""} />
        </label>
        <label className="field field-span">
          交付物链接
          <input name="deliveryUrl" defaultValue={item.deliveryUrl ?? ""} />
        </label>
        <div className="modal-actions field-span">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
