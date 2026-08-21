import { useEffect, useRef, useState } from "react";

const SEARCH_DEBOUNCE_MS = 300;

interface SearchBarProps {
  /** 输入停顿 300ms 后回调（K25 搜索框 q） */
  onSearch: (q: string) => void;
  placeholder?: string;
}

/** 列表搜索框：受控草稿 + 300ms debounce 后触发查询 */
export function SearchBar({ onSearch, placeholder = "搜索…" }: SearchBarProps) {
  const [draft, setDraft] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return (
    <input
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
