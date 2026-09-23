// K62 洞察词表（健康度 + 同义合并）：信号归一主题词的管理面。
// related 边来自 LLM 建词自带 nearest；同义词合并是修复动作（历史信号全部改指）。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { fetchTopics, mergeTopic, type TopicHealthRow } from "../api/insights";
import { useToast } from "../components/Toast";

function TopicsTable() {
  const queryClient = useQueryClient();
  const showToast = useToast();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["insights", "topics"],
    queryFn: () => fetchTopics(1),
    staleTime: 60_000,
  });
  const [mergeTarget, setMergeTarget] = useState<Record<number, string>>({});

  const merge = useMutation({
    mutationFn: ({ id, intoId }: { id: number; intoId: number }) => mergeTopic(id, intoId),
    onSuccess: (_d, { id, intoId }) => {
      showToast("已合并：历史信号与关联边已改指目标词");
      setMergeTarget((m) => {
        const next = { ...m };
        delete next[id];
        delete next[intoId];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["insights", "topics"] });
    },
    onError: (err: Error) => showToast(err.message),
  });

  return (
    <div style={{ padding: "22px 26px", maxWidth: 1180, margin: "0 auto" }}>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>洞察词表</h1>
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13 }}>
          信号归一主题词的健康度：零匹配/低频词做同义合并，related 边来自 LLM 建词自带最近邻。
        </p>
      </header>
      {isLoading && <p style={{ color: "var(--text-3)" }}>加载中…</p>}
      {isError && <p style={{ color: "var(--accent)" }}>加载失败，请稍后重试。</p>}
      {data && (
        <div style={{ background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 10, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr>
                {["词", "信号数", "需求", "供给", "关联词（related）", "同义合并"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: "var(--text-3)", fontWeight: 500, borderBottom: "1px solid var(--hairline)", whiteSpace: "nowrap" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.data.map((t: TopicHealthRow) => {
                const candidates = data.data.filter((x: TopicHealthRow) => x.id !== t.id);
                return (
                  <tr key={t.id} style={{ borderBottom: "1px solid var(--hairline)" }}>
                    <td style={{ padding: "8px 12px", fontWeight: 600 }}>{t.name}</td>
                    <td style={{ padding: "8px 12px", fontVariantNumeric: "tabular-nums" }}>{t.signalCount}</td>
                    <td style={{ padding: "8px 12px", fontVariantNumeric: "tabular-nums" }}>{t.needCount}</td>
                    <td style={{ padding: "8px 12px", fontVariantNumeric: "tabular-nums" }}>{t.supplyCount}</td>
                    <td style={{ padding: "8px 12px", color: "var(--text-3)", maxWidth: 260 }}>{t.relatedNames.join("、") || "—"}</td>
                    <td style={{ padding: "8px 12px" }}>
                      {candidates.length > 0 && (
                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                          <select
                            aria-label={`合并 ${t.name} 到`}
                            value={mergeTarget[t.id] ?? ""}
                            onChange={(e) => setMergeTarget((m) => ({ ...m, [t.id]: e.target.value }))}
                            style={{ padding: "4px 8px", border: "1px solid var(--hairline)", borderRadius: 6, fontSize: 12 }}
                          >
                            <option value="">选择目标词…</option>
                            {candidates.map((c: TopicHealthRow) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="ghost-btn"
                            disabled={!mergeTarget[t.id] || merge.isPending}
                            style={{ fontSize: 12 }}
                            onClick={() => merge.mutate({ id: t.id, intoId: Number(mergeTarget[t.id]) })}
                          >
                            合并
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ color: "var(--text-3)", fontSize: 12, marginTop: 10 }}>
        合并语义：本词的历史信号（含已取代）topic_id 全部改指目标词，related 边迁移，本词软删——一次管理动作修复历史全部。
      </p>
    </div>
  );
}

export function InsightsTopicsPage() {
  return <TopicsTable />;
}
