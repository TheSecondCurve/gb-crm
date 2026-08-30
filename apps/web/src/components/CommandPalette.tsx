import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api, buildQuery } from "../api/client";
import type { CustomerDto } from "../api/types";
import { useAuth } from "../auth/AuthProvider";

const SEARCH_DEBOUNCE_MS = 200;
const RESULT_LIMIT = 8;

/**
 * 全局快速搜索（Cmd/Ctrl+K）：跨实体定位客户，回车/点击进入客户总览。
 * 目前聚焦客户（主数据第一实体），结构可扩展成交/资料等资源。
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const canSearch = (me?.pages ?? []).includes("customers") || (me?.pages ?? []).includes("my-customers");

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CustomerDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cmd/Ctrl+K 打开
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 打开时重置并聚焦输入框
  useEffect(() => {
    if (!open) return;
    setQ("");
    setResults([]);
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const runSearch = useCallback((value: string) => {
    const v = value.trim();
    if (v === "") {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void api
      .get<{ data: CustomerDto[] }>(`/customers${buildQuery({ q: v, pageSize: RESULT_LIMIT })}`)
      .then((res) => {
        setResults(res?.data ?? []);
        setActive(0);
      })
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
  }, []);

  const select = (c: CustomerDto) => {
    setOpen(false);
    navigate(`/customers/${c.id}`);
  };

  const go = (dir: 1 | -1) => {
    if (results.length === 0) return;
    setActive((a) => (a + dir + results.length) % results.length);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      select(results[active]);
    }
  };

  if (!open || !canSearch) return null;

  return (
    <div
      className="modal-mask palette-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="command-palette" role="dialog" aria-label="快速搜索">
        <input
          ref={inputRef}
          type="search"
          aria-label="快速搜索"
          placeholder="搜索客户名 / 手机号 / 微信…"
          value={q}
          autoComplete="off"
          onChange={(e) => {
            const value = e.target.value;
            setQ(value);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => runSearch(value), SEARCH_DEBOUNCE_MS);
          }}
          onKeyDown={onInputKeyDown}
        />
        <div className="palette-body">
          {q.trim() === "" ? (
            <div className="palette-empty">输入关键字搜索客户，回车快速进入总览</div>
          ) : loading ? (
            <div className="palette-empty">搜索中…</div>
          ) : results.length === 0 ? (
            <div className="palette-empty">未找到匹配客户</div>
          ) : (
            <ul className="palette-list" role="listbox" aria-label="搜索结果">
              {results.map((c, i) => (
                <li
                  key={c.id}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "palette-item active" : "palette-item"}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => select(c)}
                >
                  <span className="palette-name">{c.nickname}</span>
                  <span className="palette-meta">
                    {c.phone || c.wechat || c.city ? [c.phone, c.wechat, c.city].filter(Boolean).join(" / ") : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="palette-footer">
          <span>↑↓ 选择</span>
          <span>回车 进入</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
