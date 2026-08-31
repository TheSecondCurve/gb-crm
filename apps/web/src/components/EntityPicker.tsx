// 关联实体选择器（本轮唯一新关联控件，后续替换其它手写 picker 也用它）：
// 已选 chips 常驻顶部（复用 .chip 视觉，带 × 移除）+ 搜索输入（300ms 防抖调 loader，
// loader 自带 label cache 填充）+ 候选下拉（点击/Enter 添加；已选滤除；↑↓ 导航、Esc 收起）。
// multiple={false} 单选模式：选中即替换、chip × 即清空。
import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";

import type { RelationOption } from "./DataGrid/DataGrid";
import type { RelationLoader } from "../columns/relation";

const SEARCH_DEBOUNCE_MS = 300;

interface EntityPickerProps {
  /** 搜索选项加载器（relation.ts 的 *OptionsLoader），返回同时填充 cache */
  loader: RelationLoader;
  /** id→label 缓存；已选 chip 的 label 取 cache.get(id) ?? `#id` */
  cache: Map<number, string>;
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  /** 默认 true（多选）；false = 单选（选中替换、× 清空） */
  multiple?: boolean;
  placeholder?: string;
  /** 搜索输入的无障碍名（外层不用 <label> 包裹，避免 chip 按钮抢占关联） */
  ariaLabel?: string;
  disabled?: boolean;
}

export function EntityPicker({
  loader,
  cache,
  selectedIds,
  onChange,
  multiple = true,
  placeholder = "搜索…",
  ariaLabel,
  disabled = false,
}: EntityPickerProps) {
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // 300ms 防抖搜索；仅下拉展开时请求
  useEffect(() => {
    if (!open || disabled) return;
    const timer = setTimeout(() => {
      void loader(search).then((opts) => {
        setOptions(opts);
        setActive(0);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, open, disabled, loader]);

  // 点击组件外收起下拉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 已选滤除
  const candidates = options.filter((o) => !selectedIds.includes(o.id));

  const add = (option: RelationOption) => {
    cache.set(option.id, option.label);
    onChange(multiple ? [...selectedIds, option.id] : [option.id]);
    setSearch("");
    if (!multiple) setOpen(false);
  };

  const remove = (id: number) => {
    onChange(selectedIds.filter((v) => v !== id));
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (candidates.length > 0) setActive((a) => (a + 1) % candidates.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (candidates.length > 0) setActive((a) => (a - 1 + candidates.length) % candidates.length);
    } else if (e.key === "Enter") {
      if (open && candidates[active]) {
        e.preventDefault();
        add(candidates[active]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  return (
    <div className="entity-picker" ref={rootRef}>
      {selectedIds.length > 0 && (
        <div className="entity-picker-chips">
          {selectedIds.map((id) => (
            <span className="chip" key={id}>
              {cache.get(id) ?? `#${id}`}
              {!disabled && (
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`移除 ${cache.get(id) ?? `#${id}`}`}
                  onClick={() => remove(id)}
                >
                  <X weight="bold" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {(multiple || selectedIds.length === 0) && !disabled && (
        <div className="entity-picker-box">
          <input
            type="search"
            autoComplete="off"
            placeholder={placeholder}
            aria-label={ariaLabel ?? placeholder}
            value={search}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setSearch(e.target.value);
              setOpen(true);
            }}
            onKeyDown={onInputKeyDown}
          />
          {open && (
            <ul className="entity-picker-list" role="listbox">
              {candidates.length === 0 && <li className="entity-picker-empty">无匹配项</li>}
              {candidates.map((o, i) => (
                <li
                  key={o.id}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "entity-picker-option active" : "entity-picker-option"}
                  onMouseEnter={() => setActive(i)}
                  // mousedown 先于 input blur，保证点击能选中
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(o);
                  }}
                >
                  {o.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
