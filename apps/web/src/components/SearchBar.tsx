import { useEffect, useRef, useState } from "react";

const SEARCH_DEBOUNCE_MS = 300;

interface SearchBarProps {
  /** 输入停顿 300ms 后回调（K25 搜索框 q） */
  onSearch: (q: string) => void;
  placeholder?: string;
}

/** 列表搜索框：受控草稿 + 300ms debounce 后触发查询；按 `/` 聚焦快捷（非输入场景） */
export function SearchBar({ onSearch, placeholder = "搜索…" }: SearchBarProps) {
  const [draft, setDraft] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // `/` 聚焦搜索框：仅在当前焦点不在任何输入控件时触发，避免抢走用户在表单里的按键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t?.isContentEditable ?? false)) {
        return;
      }
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <input
      ref={inputRef}
      type="search"
      aria-label="搜索"
      placeholder={placeholder}
      value={draft}
      onChange={(e) => {
        const value = e.target.value;
        setDraft(value);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => onSearchRef.current(value), SEARCH_DEBOUNCE_MS);
      }}
    />
  );
}
