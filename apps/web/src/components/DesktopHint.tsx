import { useState } from "react";

import { MOBILE_BREAKPOINT, useMediaQuery } from "../hooks/useMediaQuery";

const DISMISS_KEY = "gb-crm:desktop-hint-dismissed";

/**
 * 重度桌面工具页（甘特/矩阵/圈子工作台）的移动端提示条（K67 保底可用策略）。
 * 仅手机断点渲染，关闭后 localStorage 记忆不再提示。
 */
export function DesktopHint() {
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  if (!isMobile || dismissed) return null;

  return (
    <div className="desktop-hint" role="note">
      <span>本页为桌面重度工具，小屏仅供查看，建议用桌面端获得完整操作体验。</span>
      <button
        type="button"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            /* 忽略持久化失败 */
          }
          setDismissed(true);
        }}
      >
        知道了
      </button>
    </div>
  );
}
