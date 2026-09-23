// K62 温度引擎（纯函数）：事件注入热量、时间指数衰减。
// raw = Σ 权重 × 2^(−距今天数 / 21)，温度 = clamp(round(raw × 10), 0, 100)。
// 口径常量在 @gb-crm/shared insights.ts（引擎/页面/agent 共用）；本文件只做计算与事件装配。
import { TEMPERATURE } from "@gb-crm/shared";

/** 单条温度事件（已带权重；weight 可为负 = 降温，如退款） */
export interface TemperatureEvent {
  customerId: number;
  /** epoch ms */
  at: number;
  weight: number;
}

const DAY_MS = 86_400_000;

/** 温度计算；windowDays 提供时只统计窗口内事件（时间机器）。 */
export function computeTemperature(
  events: readonly TemperatureEvent[],
  now: number,
  windowDays?: number,
): number {
  const cutoff = windowDays !== undefined ? now - windowDays * DAY_MS : -Infinity;
  let raw = 0;
  for (const e of events) {
    if (e.at < cutoff || e.at > now) continue;
    const days = Math.max(0, (now - e.at) / DAY_MS);
    raw += e.weight * Math.pow(2, -days / TEMPERATURE.halfLifeDays);
  }
  return Math.max(0, Math.min(100, Math.round(raw * TEMPERATURE.scale)));
}

/** 等分采样温度序列（深潜页曲线）：[now − windowDays, now] 上 buckets 个点（含端点）。 */
export function computeTemperatureSeries(
  events: readonly TemperatureEvent[],
  now: number,
  windowDays: number,
  buckets: number,
): { at: number; temp: number }[] {
  const points: { at: number; temp: number }[] = [];
  const span = windowDays * DAY_MS;
  const step = buckets > 1 ? span / (buckets - 1) : 0;
  for (let i = 0; i < buckets; i++) {
    const t = now - span + i * step;
    points.push({ at: Math.round(t), temp: computeTemperature(events, t, windowDays) });
  }
  return points;
}

/**
 * 进行中交付的持续接触权重：锚点（starts_at 或 created_at）距 now 每满一周 +1，至少 1，封顶 3。
 * 视为当下事件（at = now，不衰减）。
 */
export function activeDeliveryWeight(anchorAt: number, now: number): number {
  const weeks = Math.max(0, (now - anchorAt) / (7 * DAY_MS));
  return Math.min(
    TEMPERATURE.eventWeights.activeDeliveryCap,
    Math.max(1, Math.ceil(weeks)) * TEMPERATURE.eventWeights.activeDeliveryPerWeek,
  );
}
