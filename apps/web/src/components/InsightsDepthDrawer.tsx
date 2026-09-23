// K62 深潜抽屉：任何洞察页面点到客户名滑出。温度大字 + 走势 sparkline + 信号时间线 + 直达总览页。
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { fetchDepth, type DepthDto } from "../api/insights";
import { formatDateTime } from "../columns/common";

function bandClass(temp: number): string {
  if (temp >= 60) return "temp-band-hot";
  if (temp >= 25) return "temp-band-warm";
  return "temp-band-frozen";
}

/** 手绘 SVG sparkline（零依赖）：温度序列折线 + 当前点 */
function TempSparkline({ series }: { series: DepthDto["temperatureSeries"] }) {
  if (series.length < 2) return null;
  const w = 260;
  const h = 56;
  const min = 0;
  const max = Math.max(100, ...series.map((p) => p.temp));
  const pts = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * (w - 4) + 2;
      const y = h - 4 - ((p.temp - min) / (max - min)) * (h - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = series[series.length - 1]!;
  const lastX = w - 2;
  const lastY = h - 4 - ((last.temp - min) / (max - min)) * (h - 8);
  return (
    <svg width={w} height={h} aria-label="温度走势（近 180 天）" role="img">
      <polyline points={pts} fill="none" stroke="var(--temp-warm)" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={3.5} fill="var(--accent)" />
    </svg>
  );
}

const yuan = (cents: number): string =>
  cents > 0 ? `¥${(cents / 100).toLocaleString("zh-Hans-CN", { maximumFractionDigits: 0 })}` : "—";

const STATUS_LABEL: Record<string, string> = {
  active: "有效",
  superseded: "已被取代",
  rejected: "已否决",
  expired: "已过期",
};

export function InsightsDepthDrawer({
  customerId,
  onClose,
}: {
  customerId: number | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["insights", "depth", customerId],
    queryFn: () => fetchDepth(customerId!),
    enabled: customerId !== null,
    staleTime: 60_000,
  });

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20,18,16,0.32)",
        zIndex: 60,
      }}
    >
      <aside
        role="dialog"
        aria-label="客户深潜"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(420px, 92vw)",
          background: "var(--cream)",
          boxShadow: "-8px 0 32px rgba(20,18,16,0.18)",
          padding: "20px 22px",
          overflowY: "auto",
          animation: `insights-drawer-in var(--drawer-dur) var(--drawer-ease)`,
        }}
      >
        <style>{`@keyframes insights-drawer-in { from { transform: translateX(24px); opacity: 0 } to { transform: none; opacity: 1 } }`}</style>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>{data ? data.customer.nickname : "客户深潜"}</h3>
          <button type="button" className="ghost-btn" aria-label="关闭深潜" onClick={onClose}>
            <X size={18} weight="bold" aria-hidden />
          </button>
        </header>

        {isLoading && <p style={{ color: "var(--text-3)" }}>加载中…</p>}
        {isError && <p style={{ color: "var(--accent)" }}>加载失败，请稍后重试。</p>}

        {data && (
          <>
            <p style={{ color: "var(--text-2)", margin: "6px 0 14px", fontSize: 13 }}>
              {[data.customer.city, data.customer.ownerName ? `归属 ${data.customer.ownerName}` : null]
                .filter(Boolean)
                .join(" · ") || "—"}
            </p>

            <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 4px" }}>
              <span className={bandClass(data.temperature)} style={{ fontSize: 44, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                {data.temperature}°
              </span>
              <span style={{ color: "var(--text-3)", fontSize: 13 }}>客户温度（近 90 天窗口）</span>
            </div>
            <TempSparkline series={data.temperatureSeries} />

            <dl style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", margin: "14px 0" }}>
              <div>
                <dt style={{ color: "var(--text-3)", fontSize: 12 }}>已付款累计</dt>
                <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{yuan(data.paidTotalCents)}</dd>
              </div>
              <div>
                <dt style={{ color: "var(--text-3)", fontSize: 12 }}>产品阶梯</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{data.ladder}</dd>
              </div>
            </dl>

            <h4 style={{ margin: "14px 0 8px", fontSize: 14 }}>信号时间线</h4>
            {data.signals.length === 0 && <p style={{ color: "var(--text-3)", fontSize: 13 }}>暂无信号（维护记录落库后会自动抽取）</p>}
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {data.signals.map((s) => (
                <li
                  key={s.id}
                  style={{
                    borderLeft: s.status === "active" ? "3px solid var(--temp-warm)" : "3px solid var(--hairline)",
                    paddingLeft: 10,
                    opacity: s.status === "active" ? 1 : 0.55,
                  }}
                >
                  <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                    {formatDateTime(s.sourceAt)} · {s.typeLabel}
                    {s.topicName ? ` · ${s.topicName}` : ""}
                    {s.mentionCount > 1 ? ` · 提及 ${s.mentionCount} 次` : ""}
                    {s.status !== "active" ? ` · ${STATUS_LABEL[s.status] ?? s.status}` : ""}
                  </div>
                  <div style={{ fontSize: 13 }}>{s.content}</div>
                </li>
              ))}
            </ul>

            <Link
              to={`/customers/${data.customer.id}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 16, fontSize: 13 }}
            >
              打开客户总览 <ArrowSquareOut size={14} weight="bold" aria-hidden />
            </Link>
          </>
        )}
      </aside>
    </div>
  );
}
