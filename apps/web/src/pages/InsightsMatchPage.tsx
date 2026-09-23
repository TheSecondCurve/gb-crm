// K62 缘份清单：need × supply 撮合建议 + 活动策划聚合。只建议不自动牵线——引荐的话术与时机是人的判断。
import { useState } from "react";

import { fetchMatch, type MatchDto } from "../api/insights";
import { CustomerButton, DecisionSheet } from "../components/DecisionSheet";
import { InsightsDepthDrawer } from "../components/InsightsDepthDrawer";

export function InsightsMatchPage() {
  const [depthId, setDepthId] = useState<number | null>(null);
  return (
    <>
      <DecisionSheet
        title="缘分清单"
        subtitle="客户之间的互需关系：需求 × 供给确定性匹配（词表精确 + 关联召回）。只建议，不自动牵线。"
        queryKey={["insights", "match"]}
        queryFn={fetchMatch}
        openDepth={setDepthId}
        render={(data: MatchDto, openDepth) => (
          <div style={{ display: "grid", gap: 12 }}>
            {data.pairs.map((p, i) => (
              <article
                key={`${p.needCustomerId}-${p.supplyCustomerId}-${i}`}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--hairline)",
                  borderRadius: 10,
                  padding: "14px 18px",
                }}
              >
                <header style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <CustomerButton id={p.needCustomerId} nickname={p.needNickname} openDepth={openDepth} />
                  <span style={{ color: "var(--text-3)" }}>×</span>
                  <CustomerButton id={p.supplyCustomerId} nickname={p.supplyNickname} openDepth={openDepth} />
                  <span style={{ fontWeight: 600 }}>· {p.topic}</span>
                  {p.viaRelated && (
                    <span style={{ fontSize: 11, border: "1px solid var(--hairline)", borderRadius: 999, padding: "1px 8px", color: "var(--text-3)" }}>
                      经词表关联
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>匹配分 {p.score}</span>
                </header>
                <p style={{ margin: "8px 0 6px", fontSize: 13, color: "var(--text-2)" }}>
                  <span style={{ color: "var(--text-3)" }}>需求：</span>
                  {p.needEvidence}
                  <span style={{ color: "var(--text-3)" }}> ｜ 供给：</span>
                  {p.supplyEvidence}
                </p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)" }}>
                  共同点：{[p.sameCity ? "同城" : null, p.sharedDeliveries > 0 ? `共同参与交付 ${p.sharedDeliveries} 个` : null].filter(Boolean).join(" · ") || "暂无重叠（引荐前先各自对齐期待）"}
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 12 }}>
                  建议动作：一对一引荐 / 下一场下午茶凑同一桌 / 拉三人小群
                </p>
              </article>
            ))}
            {data.pairs.length === 0 && (
              <p style={{ color: "var(--text-3)", fontSize: 14 }}>
                暂无撮合建议——need/supply 信号随维护记录抽取自动积累。
              </p>
            )}
          </div>
        )}
      />
      {depthId !== null && <InsightsDepthDrawer customerId={depthId} onClose={() => setDepthId(null)} />}
    </>
  );
}
