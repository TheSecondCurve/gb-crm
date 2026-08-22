// 列定义共享助手：枚举选项、徽章展示、日期格式化。labels 全部来自 @gb-crm/shared（禁止另写中文映射）。
import type { ReactNode } from "react";

export type BadgeTone = "plain" | "accent" | "muted";

export function badge(text: string, tone: BadgeTone = "plain"): ReactNode {
  const cls =
    tone === "accent" ? "badge badge-accent" : tone === "muted" ? "badge badge-muted" : "badge";
  return <span className={cls}>{text}</span>;
}

/** select / multi 编辑器选项：shared labels → { value, label }[] */
export function optionsOf(labels: Record<string, string>): { value: string; label: string }[] {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

/** 枚举列只读展示：badge 按语义着色（accent=正向，muted=停用/负向）；null → — */
export function enumBadge(
  labels: Record<string, string>,
  tones: Record<string, BadgeTone> = {},
): (value: string | null) => ReactNode {
  return (value) => {
    if (value === null || value === "") return "—";
    return badge(labels[value] ?? value, tones[value] ?? "plain");
  };
}

/** epoch ms → YYYY-MM-DD HH:mm（本地时区）；null → "" */
export function formatDateTime(ts: number | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 审计/外键展开列展示：{ nickname } | null → 名字 */
export function refName(ref: { nickname: string } | null): string {
  return ref?.nickname ?? "";
}
