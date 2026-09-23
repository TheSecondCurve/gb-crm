// K62 决策台共享壳：标题 + 结论先行人话行 + 内容区。四张决策台共用（视觉与透视台一致）。
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

export interface Decision {
  title: string;
  subtitle: string;
  endpoint: string;
}

export function DecisionSheet<T>({
  title,
  subtitle,
  queryKey,
  queryFn,
  render,
  openDepth,
}: {
  title: string;
  subtitle: string;
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  render: (data: T, openDepth: (id: number) => void) => ReactNode;
  openDepth: (id: number) => void;
}) {
  const { data, isLoading, isError } = useQuery({ queryKey, queryFn, staleTime: 60_000 });

  return (
    <div style={{ padding: "22px 26px", maxWidth: 1180, margin: "0 auto" }}>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ fontSize: 22, margin: "0 0 6px" }}>{title}</h1>
        <p style={{ margin: 0, color: "var(--text-2)", fontSize: 13 }}>{subtitle}</p>
      </header>
      {isLoading && <p style={{ color: "var(--text-3)" }}>装配中…</p>}
      {isError && <p style={{ color: "var(--accent)" }}>加载失败，请稍后重试。</p>}
      {data && (
        <>
          <p
            data-testid="decision-headline"
            style={{
              fontSize: "var(--insight-headline, 22px)",
              fontWeight: 600,
              lineHeight: 1.5,
              margin: "0 0 18px",
              maxWidth: 900,
            }}
          >
            {(data as unknown as { conclusion: string }).conclusion}
          </p>
          {render(data, openDepth)}
        </>
      )}
    </div>
  );
}

/** 客户名按钮（点开深潜），决策台列表内到处用 */
export function CustomerButton({ id, nickname, openDepth }: { id: number; nickname: string; openDepth: (id: number) => void }) {
  return (
    <button
      type="button"
      className="link-btn"
      style={{ fontSize: 14, fontWeight: 600 }}
      onClick={() => openDepth(id)}
    >
      {nickname}
    </button>
  );
}
