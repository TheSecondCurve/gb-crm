import type { ReactNode } from "react";

export type GridEditorType = "text" | "textarea" | "select" | "multi" | "relation" | "relation-one";

export interface RelationOption {
  id: number;
  label: string;
}

/**
 * DataGrid 列定义（Appendix B 约定的落地）。业务列在 PR 10/11 的 columns/*.ts 里组装：
 * editable 由调用方按 can() 算好传入；labels 来自 packages/shared。
 */
export interface GridColumn<Row> {
  /** 行上的取值键 / 展示键 */
  key: string;
  label: string;
  /** 编辑器类型；null/缺省 = 无编辑器 */
  editor?: GridEditorType | null;
  /** 是否可编（需要 editor 同时非 null）；assistant 只读等由调用方算好 */
  editable?: boolean;
  /** 默认可见；缺省 true。列选择器可覆盖并持久化 */
  defaultVisible?: boolean;
  width?: number;
  /** PATCH body 里的键；缺省 = key（关系列常是 ownerIds ≠ 展示键 owners） */
  patchKey?: string;
  /** select / multi 的选项 */
  options?: { value: string; label: string }[];
  /** relation / relation-one 的可搜索选项加载器（调用方注入，如 GET 轻量列表） */
  relationLoader?: (search: string) => Promise<RelationOption[]>;
  /** 编辑初值；缺省 row[key]。relation 约定返回 number[]，relation-one 返回 number | null */
  getValue?: (row: Row) => unknown;
  /** 只读展示（格式化日期、badge 等）；缺省按值直接渲染 */
  render?: (row: Row) => ReactNode;
  /** 乐观更新如何落到行上；缺省 { ...row, [key]: value }（关系列展示结构不同于此值时用） */
  applyOptimistic?: (row: Row, value: unknown) => Row;
}

/** 行约束：行级 OCC 需要 updatedAt */
export type GridRow = { id: number; updatedAt: number };
