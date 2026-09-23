// K62 意图台：问过未买 / 交叉销售 / 需求主题热度。清单 + topic 芯片。
import { useState } from "react";

import { fetchIntent, type IntentDto } from "../api/insights";
import { CustomerButton, DecisionSheet } from "../components/DecisionSheet";
import { InsightsDepthDrawer } from "../components/InsightsDepthDrawer";
import { formatDateTime } from "../columns/common";

export function InsightsIntentPage() {
  const [depthId, setDepthId] = useState<number | null>(null);
  return (
    <>
      <DecisionSheet
        title="意图台"
        subtitle="谁在等我回访：活跃意向/需求清单（温度排序）、需求主题热度、交叉销售窗口。"
        queryKey={["insights", "intent"]}
        queryFn={fetchIntent}
        openDepth={setDepthId}
        render={(data: IntentDto, openDepth) => (
          <div style={{ display: "grid", gap: 14 }}>
            {data.topics.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {data.topics.slice(0, 12).map((t) => (
                  <span
                    key={t.topic}
                    style={{
                      fontSize: 12,
                      padding: "4px 12px",
                      borderRadius: 999,
                      border: "1px solid var(--hairline)",
                      background: "var(--surface)",
                    }}
                  >
                    {t.topic} <strong style={{ fontVariantNumeric: "tabular-nums" }}>{t.count}</strong>
                    <span style={{ color: "var(--text-3)" }}> / {t.cityCount} 城</span>
                  </span>
                ))}
              </div>
            )}
            <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 10, overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                <thead>
                  <tr>
                    {["客户", "意向", "主题", "内容", "温度", "发生时间"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: "var(--text-3)", fontWeight: 500, borderBottom: "1px solid var(--hairline)", whiteSpace: "nowrap" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={`${r.customerId}-${i}`} style={{ borderBottom: "1px solid var(--hairline)" }}>
                      <td style={{ padding: "8px 12px" }}>
                        <CustomerButton id={r.customerId} nickname={r.nickname} openDepth={openDepth} />
                        {r.crossSell && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>交叉销售</span>
                        )}
                      </td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{r.typeLabel}</td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{r.topic ?? "—"}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-2)", maxWidth: 360 }}>{r.content}</td>
                      <td style={{ padding: "8px 12px", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }} className={r.temperature >= 60 ? "temp-band-hot" : r.temperature >= 25 ? "temp-band-warm" : undefined}>
                        {r.temperature}°
                      </td>
                      <td style={{ padding: "8px 12px", color: "var(--text-3)", whiteSpace: "nowrap" }}>{formatDateTime(r.sourceAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      />
      {depthId !== null && <InsightsDepthDrawer customerId={depthId} onClose={() => setDepthId(null)} />}
    </>
  );
}
