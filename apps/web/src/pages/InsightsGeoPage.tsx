// K62 选址台：下一场活动在哪办。城市卡网格 + 结论行；点客户名深潜。
import { useState } from "react";

import { fetchGeo, type GeoDto } from "../api/insights";
import { CustomerButton, DecisionSheet } from "../components/DecisionSheet";
import { InsightsDepthDrawer } from "../components/InsightsDepthDrawer";

const yuan = (cents: number): string =>
  cents > 0 ? `¥${(cents / 100).toLocaleString("zh-Hans-CN", { maximumFractionDigits: 0 })}` : "—";

function CityCard({
  city,
  customers,
  warm,
  hot,
  paidTotalCents,
  activeNeeds,
  renewals,
  eventAttendance,
  sample,
  customerIds,
  openDepth,
}: GeoDto["cities"][number] & { openDepth: (id: number) => void }) {
  return (
    <article
      style={{
        background: "var(--surface)",
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        padding: "16px 18px",
        minWidth: 240,
      }}
    >
      <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>{city}</h3>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px 10px", margin: 0 }}>
        <div>
          <dt style={{ fontSize: 11, color: "var(--text-3)" }}>客户</dt>
          <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{customers}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 11, color: "var(--text-3)" }}>暖客户</dt>
          <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }} className={warm > 0 ? "temp-band-warm" : undefined}>
            {warm}
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: 11, color: "var(--text-3)" }}>活跃</dt>
          <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }} className={hot > 0 ? "temp-band-hot" : undefined}>
            {hot}
          </dd>
        </div>
        <div>
          <dt style={{ fontSize: 11, color: "var(--text-3)" }}>活跃需求</dt>
          <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{activeNeeds}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 11, color: "var(--text-3)" }}>30 天续费</dt>
          <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{renewals}</dd>
        </div>
        <div>
          <dt style={{ fontSize: 11, color: "var(--text-3)" }}>历史场次</dt>
          <dd style={{ margin: 0, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{eventAttendance}</dd>
        </div>
      </dl>
      <p style={{ margin: "10px 0 4px", fontSize: 12, color: "var(--text-3)" }}>在册已付 {yuan(paidTotalCents)}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {sample.map((name, i) => (
          <CustomerButton key={customerIds[i] ?? i} id={customerIds[i] ?? 0} nickname={name} openDepth={openDepth} />
        ))}
      </div>
    </article>
  );
}

export function InsightsGeoPage() {
  const [depthId, setDepthId] = useState<number | null>(null);
  return (
    <>
      <DecisionSheet
        title="选址台"
        subtitle="下一场下午茶 / 线下活动在哪办：城市 × 暖客户密度 × 未消化需求 × 历史场次。"
        queryKey={["insights", "geo"]}
        queryFn={fetchGeo}
        openDepth={setDepthId}
        render={(data: GeoDto, openDepth) => (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
            {data.cities.map((c) => (
              <CityCard key={c.city} {...c} openDepth={openDepth} />
            ))}
          </div>
        )}
      />
      {depthId !== null && <InsightsDepthDrawer customerId={depthId} onClose={() => setDepthId(null)} />}
    </>
  );
}
