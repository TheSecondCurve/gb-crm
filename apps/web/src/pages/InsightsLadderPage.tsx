// K62 阶梯台：产品阶梯分布 + 升级就绪名单 + 标签过期候选。
import { useState } from "react";

import { fetchLadder, type LadderDto } from "../api/insights";
import { CustomerButton, DecisionSheet } from "../components/DecisionSheet";
import { InsightsDepthDrawer } from "../components/InsightsDepthDrawer";

export function InsightsLadderPage() {
  const [depthId, setDepthId] = useState<number | null>(null);
  return (
    <>
      <DecisionSheet
        title="阶梯台"
        subtitle="嘉宾 → 活动/知识 → 咨询 → 圈子 → 多类复购：行为推导的梯级分布，谁站在升级门口。"
        queryKey={["insights", "ladder"]}
        queryFn={fetchLadder}
        openDepth={setDepthId}
        render={(data: LadderDto, openDepth) => (
          <div style={{ display: "grid", gap: 14 }}>
            {data.rungs.map((r, i) => {
              const max = Math.max(1, ...data.rungs.map((x) => x.count));
              return (
                <section key={r.key} style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 10, padding: "14px 18px" }}>
                  <header style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <span style={{ fontSize: 12, color: "var(--text-3)" }}>第 {i + 1} 级</span>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{r.label}</h3>
                    <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{r.count}</span>
                    {r.upgradeReadyCount > 0 && (
                      <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>升级就绪 {r.upgradeReadyCount}</span>
                    )}
                  </header>
                  <div style={{ height: 6, background: "var(--bg)", borderRadius: 3, margin: "8px 0", overflow: "hidden" }}>
                    <div style={{ width: `${(r.count / max) * 100}%`, height: "100%", background: "var(--temp-warm)", opacity: 0.6 }} />
                  </div>
                  {r.upgradeReady.length > 0 && (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                      {r.upgradeReady.map((u, idx) => (
                        <li key={`${u.customerId}-${idx}`} style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <CustomerButton id={u.customerId} nickname={u.nickname} openDepth={openDepth} />
                          <span style={{ color: "var(--text-3)" }}>→ {u.nextLabel}</span>
                          <span style={{ color: "var(--text-2)" }}>
                            {u.topic ? `「${u.topic}」` : ""}
                            {u.evidence}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.upgradeReady.length === 0 && r.sample.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {r.sample.map((s) => (
                        <CustomerButton key={s.id} id={s.id} nickname={s.nickname} openDepth={openDepth} />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
            {data.staleTagCandidates.length > 0 && (
              <section style={{ background: "var(--surface)", border: "1px dashed var(--hairline)", borderRadius: 10, padding: "14px 18px" }}>
                <h3 style={{ margin: "0 0 6px", fontSize: 14, color: "var(--text-3)" }}>
                  标签过期候选（{data.staleTagCount}）：有阶段标签但零成交动作
                </h3>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                  {data.staleTagCandidates.map((c) => (
                    <li key={c.customerId} style={{ fontSize: 13 }}>
                      <CustomerButton id={c.customerId} nickname={c.nickname} openDepth={openDepth} />
                      <span style={{ color: "var(--text-3)" }}> · {c.stageTags.join("、")}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      />
      {depthId !== null && <InsightsDepthDrawer customerId={depthId} onClose={() => setDepthId(null)} />}
    </>
  );
}
