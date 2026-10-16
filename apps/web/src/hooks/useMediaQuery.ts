import { useEffect, useState } from "react";

/** 手机断点（K67）：与 base.css @media 字面值、docs/style.md 约定一致，@media 不支持 CSS 变量故用字面值 */
export const MOBILE_BREAKPOINT = "(max-width: 767px)";

/**
 * CSS 媒体查询的 React 版（K67 移动端抽屉/提示条用）。
 * 环境无 matchMedia（jsdom）时恒回 false（桌面态），与既有测试兼容。
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
