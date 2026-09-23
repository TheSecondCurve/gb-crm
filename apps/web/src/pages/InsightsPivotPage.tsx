// K62 全景透视台：经纬两轴任意组合 × 时间机器窗口 × 「只看我的」。
// 结论先行（顶部人话行）+ 热度矩阵（玄黑浓度 = 客户数）+ 点格子出客户 → 点人名深潜。
import { PIVOT_AXES, type PivotAxisKey } from "@gb-crm/shared";
import { CaretDown, Sparkle } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { fetchPivot, postSummary, type PivotCellDto, type PivotDto } from "../api/insights";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toast";
import { InsightsDepthDrawer } from "../components/InsightsDepthDrawer";

const WINDOWS = [30, 90, 180, 365] as const;

/** 预置决策切片（一键换轴） */
const PRESETS: { label: string; x: PivotAxisKey; y: PivotAxisKey }[] = [
  { label: "办活动看：城市 × 阶段", x: "city", y: "stageTag" },
  { label: "回访看：兴趣 × 温度", x: "interestTag", y: "temperatureBand" },
  { label: "需求地理：城市 × 活跃信号", x: "city", y: "signal" },
  { label: "产金子渠道：渠道 × 阶梯", x: "channel", y: "ladder" },
];

function heatStyle(count: number, max: number): React.CSSProperties {
  if (count === 0) return { background: "transparent", color: "var(--text-3)" };
  const t = max === 0 ? 0 : count / max;
  const alpha = 0.06 + 0.49 * Math.sqrt(t);
  return {
    background: `rgba(20,18,16,${alpha.toFixed(3)})`,
    color: t > 0.55 ? "var(--cream)" : "var(--ink)",
    fontWeight: t > 0.55 ? 600 : 400,
  };
}

/** 顶部结论行：把矩阵压成一句人话 */
function headline(data: PivotDto): string {
  const topCol = [...data.columns].sort((a, b) => b.total - a.total)[0];
  const topRow = [...data.rows].sort((a, b) => b.total - a.total)[0];
  const parts = [`${data.total} 位客户（${data.windowDays} 天窗口）`];
  if (topCol && topCol.total > 0) parts.push(`${data.axes.x.label}最集中在「${topCol.x}」（${topCol.total}）`);
  if (topRow && topRow.total > 0 && data.axes.y.key !== data.axes.x.key) {
    parts.push(`${data.axes.y.label}最多是「${topRow.y}」（${topRow.total}）`);
  }
  return parts.join("，") + "。";
}

export function InsightsPivotPage() {
  const { me } = useAuth();
  const [x, setX] = useState<PivotAxisKey>("city");
  const [y, setY] = useState<PivotAxisKey>("stageTag");
  const [windowDays, setWindowDays] = useState<number>(90);
  const [mineOnly, setMineOnly] = useState(false);
  const [cell, setCell] = useState<PivotCellDto | null>(null);
  const [depthId, setDepthId] = useState<number | null>(null);
  const showToast = useToast();
  const summary = useMutation({
    mutationFn: postSummary,
    onError: (err: Error) => showToast(err.message),
  });

  const ownerId = mineOnly && me ? me.id : undefined;
  const { data, isLoading, isError } = useQuery({
    queryKey: ["insights", "pivot", x, y, windowDays, ownerId ?? 0],
    queryFn: () => fetchPivot({ x, y, window: windowDays, ownerId }),
    staleTime: 60_000,
  });

  const maxCell = useMemo(() => {
    if (!data) return 0;
    return Math.max(0, ...data.rows.flatMap((r) => r.cells.map((c) => c.count)));
  }, [data]);

  const axisSelect = (
    label: string,
    value: PivotAxisKey,
    onChange: (v: PivotAxisKey) => void,
    id: string,
  ) => (
    <label htmlFor={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
      {label}
      <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value as PivotAxisKey)}
          style={{ appearance: "none", padding: "6px 26px 6px 10px", border: "1px solid var(--hairline)", background: "var(--surface)", borderRadius: 6, fontSize: 13 }}
        >
          {PIVOT_AXES.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
        <CaretDown size={12} weight="bold" aria-hidden style={{ position: "absolute", right: 8, pointerEvents: "none", color: "var(--text-3)" }} />
      </span>
    </label>
  );

  return (
    <div style={{ padding: "22px 26px", maxWidth: 1180, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>全景透视台</h1>
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13 }}>
          经纬两轴任意组合，看你的客户全景；点任何格子落到带名字的客户。
        </p>
      </header>

      {/* 控制条：经纬 + 时间机器 + 只看我的 + AI 经营备忘 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 14 }}>
        {axisSelect("经（列）", x, setX, "pivot-x")}
        <span style={{ color: "var(--text-3)" }}>×</span>
        {axisSelect("纬（行）", y, setY, "pivot-y")}
        <label htmlFor="pivot-window" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          时间机器
          <select
            id="pivot-window"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            style={{ padding: "6px 10px", border: "1px solid var(--hairline)", background: "var(--surface)", borderRadius: 6, fontSize: 13 }}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                近 {w} 天
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          只看我的
        </label>
        <button
          type="button"
          className="ghost-btn"
          style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}
          disabled={summary.isPending}
          onClick={() => summary.mutate()}
        >
          <Sparkle size={14} weight="bold" aria-hidden />
          {summary.isPending ? "生成中…" : "AI 经营备忘"}
        </button>
      </div>
      {summary.data && (
        <p
          data-testid="ai-summary"
          style={{
            margin: "0 0 14px",
            padding: "10px 14px",
            background: "var(--surface)",
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          <span style={{ fontSize: 11, color: "var(--text-3)", marginRight: 8 }}>
            {summary.data.source === "llm" ? "AI 生成" : "规则版（LLM 未配置）"}
          </span>
          {summary.data.summary}
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="ghost-btn"
            style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: x === p.x && y === p.y ? "1px solid var(--ink)" : "1px solid var(--hairline)" }}
            onClick={() => {
              setX(p.x);
              setY(p.y);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {isLoading && <p style={{ color: "var(--text-3)" }}>装配矩阵中…</p>}
      {isError && <p style={{ color: "var(--accent)" }}>加载失败，请稍后重试。</p>}

      {data && (
        <>
          {/* 人话结论行 */}
          <p
            data-testid="insight-headline"
            style={{
              fontSize: "var(--insight-headline, 22px)",
              fontWeight: 600,
              lineHeight: 1.5,
              margin: "0 0 18px",
              maxWidth: 900,
            }}
          >
            {headline(data)}
          </p>

          <div
            className="insight-matrix"
            style={{ overflowX: "auto", background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 6 }}
          >
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "8px 10px", color: "var(--text-3)", fontWeight: 500, whiteSpace: "nowrap" }}>
                    {data.axes.y.label} ＼ {data.axes.x.label}
                  </th>
                  {data.columns.map((c) => (
                    <th key={c.x} scope="col" style={{ padding: "8px 10px", textAlign: "center", fontWeight: 600, whiteSpace: "nowrap" }} title={`${c.x}：${c.total} 位`}>
                      {c.x}
                      <span style={{ color: "var(--text-3)", fontWeight: 400, marginLeft: 4 }}>{c.total}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.y}>
                    <th scope="row" style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }} title={`${row.y}：${row.total} 位`}>
                      {row.y}
                      <span style={{ color: "var(--text-3)", fontWeight: 400, marginLeft: 4 }}>{row.total}</span>
                    </th>
                    {row.cells.map((c) => (
                      <td key={c.x} style={{ padding: 2 }}>
                        <button
                          type="button"
                          disabled={c.count === 0}
                          aria-label={`${row.y} × ${c.x}：${c.count} 位客户`}
                          onClick={() => setCell(c)}
                          style={{
                            width: "100%",
                            minWidth: 56,
                            padding: "10px 8px",
                            borderRadius: 6,
                            cursor: c.count === 0 ? "default" : "pointer",
                            fontVariantNumeric: "tabular-nums",
                            ...heatStyle(c.count, maxCell),
                          }}
                        >
                          {c.count === 0 ? "·" : c.count}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ color: "var(--text-3)", fontSize: 12, marginTop: 10 }}>
            口径：温度 = 事件权重 × 21 天半衰期（近 {data.windowDays} 天窗口）；价值 = 已付款成交累计。
            标签/渠道类轴一位客户可计入多格，行列表总数可能大于客户数。
          </p>
        </>
      )}

      {/* 格子客户清单弹层 */}
      {cell && (
        <div
          role="dialog"
          aria-label={`客户清单：${cell.y} × ${cell.x}`}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(20,18,16,0.32)",
            zIndex: 55,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCell(null);
          }}
        >
          <div style={{ background: "var(--surface)", borderRadius: 12, padding: 20, width: "min(420px, 90vw)", boxShadow: "0 12px 40px rgba(20,18,16,0.2)" }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>
              {cell.y} × {cell.x}
            </h3>
            <p style={{ margin: "0 0 12px", color: "var(--text-3)", fontSize: 13 }}>{cell.count} 位客户</p>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
              {cell.sample.map((name, i) => (
                <li key={`${cell.customerIds[i] ?? i}`}>
                  <button
                    type="button"
                    className="link-btn"
                    style={{ fontSize: 14 }}
                    onClick={() => {
                      setDepthId(cell.customerIds[i] ?? null);
                      setCell(null);
                    }}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
            {cell.count > cell.sample.length && (
              <p style={{ color: "var(--text-3)", fontSize: 12, margin: "10px 0 0" }}>
                仅展示前 {cell.sample.length} 位，共 {cell.count} 位。
              </p>
            )}
          </div>
        </div>
      )}

      {depthId !== null && <InsightsDepthDrawer customerId={depthId} onClose={() => setDepthId(null)} />}
    </div>
  );
}
