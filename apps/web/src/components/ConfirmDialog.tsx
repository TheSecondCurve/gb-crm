import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmText?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 删除等危险操作的确认框；确认键红描边不铺底（btn-danger） */
export function ConfirmDialog({
  title = "确认操作",
  message,
  confirmText = "确认",
  loading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirm-text">{message}</p>
      <div className="modal-actions">
        <button type="button" onClick={onCancel} disabled={loading}>
          取消
        </button>
        <button type="button" className="btn-danger" onClick={onConfirm} disabled={loading}>
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}
