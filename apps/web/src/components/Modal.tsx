import { useEffect, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  /** .modal-wide（560px），默认 420px */
  wide?: boolean;
  children: ReactNode;
}

/** 白底、顶 3px --accent；点遮罩或按 Esc 关闭 */
export function Modal({ title, onClose, wide, children }: ModalProps) {
  // Esc 全局取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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
