// K62 守护台：今日该看的人。确定性规则工作队列（沉睡金主/断线线索/续费窗口/意向过期），
// 紧急 = 漆红（全页唯一红，只给行动项）；建议动作指路，点客户名深潜。
import { useState } from "react";

import { fetchGuard, type GuardDto } from "../api/insights";
import { CustomerButton, DecisionSheet } from "../components/DecisionSheet";
import { InsightsDepthDrawer } from "../components/InsightsDepthDrawer";

export function InsightsGuardPage() {
  const [depthId, setDepthId] = useState<number | null>(null);
  return (
    <>
      <DecisionSheet
        title="守护台"
        subtitle="今日该看的人：沉睡金主、断线线索、续费窗口、过期意向——确定性规则，无一玄学。"
        queryKey={["insights", "guard"]}
        queryFn={fetchGuard}
        openDepth={setDepthId}
        render={(data: GuardDto, openDepth) => (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {data.items.map((item, i) => (
              <li
                key={`${item.kind}-${item.customerId}-${i}`}
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--hairline)",
                  borderLeft: `3px solid ${item.urgency === "high" ? "var(--accent)" : "var(--hairline)"}`,
                  borderRadius: 8,
                  padding: "12px 16px",
                  display: "flex",
                  gap: 12,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: item.urgency === "high" ? "var(--accent)" : "var(--text-3)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.kindLabel}
                </span>
                <CustomerButton id={item.customerId} nickname={item.nickname} openDepth={openDepth} />
                <span style={{ fontSize: 13, color: "var(--text-2)", flex: 1, minWidth: 220 }}>{item.reason}</span>
                <span style={{ fontSize: 12, color: "var(--ink)", border: "1px solid var(--hairline)", borderRadius: 999, padding: "2px 10px", whiteSpace: "nowrap" }}>
                  {item.action}
                </span>
              </li>
            ))}
            {data.items.length === 0 && (
              <li style={{ color: "var(--text-3)", fontSize: 14 }}>队列干净：没有待干预的客户信号。</li>
            )}
          </ol>
        )}
      />
      {depthId !== null && <InsightsDepthDrawer customerId={depthId} onClose={() => setDepthId(null)} />}
    </>
  );
}
