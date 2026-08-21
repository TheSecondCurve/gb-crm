import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  /** .modal-wide（560px），默认 420px */
  wide?: boolean;
  children: ReactNode;
}

/** 白底、顶 3px --accent；点遮罩关闭 */
export function Modal({ title, onClose, wide, children }: ModalProps) {
  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={wide ? "modal modal-wide" : "modal"} role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
