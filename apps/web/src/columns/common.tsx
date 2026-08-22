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

const pad = (n: number) => String(n).padStart(2, "0");

/** epoch ms（本地时区）→ YYYY-MM-DD 展示文本；null → ""（K42/K43 交付日期列） */
export function epochMsToDate(ts: number | null): string {
  if (ts === null) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * YYYY-MM-DD → 本地时区当天零点的 epoch ms；空 → null（清空语义）。
 * 非空但格式/日期非法 → null（调用方按「无效日期」提示，不静默写库）。
 */
export function dateToEpochMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return null; // 如 2026-02-30
  }
  return d.getTime();
}
