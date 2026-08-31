// EntityPicker：搜索防抖出选项 → 点击添加 chip → × 移除；换搜索词已选 chips 保留；
// 单选模式选中替换 / × 清空；键盘 ↑↓/Enter 选择；已选滤除；Esc 收起。
// 受控组件：用有状态壳模拟父级回写 selectedIds。
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EntityPicker } from "../src/components/EntityPicker";
import type { RelationOption } from "../src/components/DataGrid/DataGrid";

const ALL: RelationOption[] = [
  { id: 1, label: "张三" },
  { id: 2, label: "李四" },
  { id: 3, label: "王五" },
];

/** 简单 loader：按 label 过滤（组件 300ms 防抖后才调到） */
const loader = (search: string) =>
  Promise.resolve(ALL.filter((o) => search.trim() === "" || o.label.includes(search.trim())));

interface HarnessProps {
  multiple?: boolean;
  initial?: number[];
  onChangeSpy?: (ids: number[]) => void;
}

/** 受控壳：内部维护 selectedIds，透传 onChange 给 spy */
function Harness({ multiple = true, initial = [], onChangeSpy }: HarnessProps) {
  const [ids, setIds] = useState<number[]>(initial);
  const [cache] = useState(() => new Map<number, string>([[1, "张三"]]));
  return (
    <EntityPicker
      loader={loader}
      cache={cache}
      selectedIds={ids}
      onChange={(next) => {
        setIds(next);
        onChangeSpy?.(next);
      }}
      multiple={multiple}
      placeholder="搜索客户…"
      ariaLabel="搜索客户"
    />
  );
}

describe("EntityPicker", () => {
  it("搜索防抖出选项 → 点击添加 chip → × 移除", async () => {
    const spy: number[][] = [];
    render(<Harness onChangeSpy={(ids) => spy.push(ids)} />);
    const input = screen.getByLabelText("搜索客户");
    fireEvent.change(input, { target: { value: "张" } });

    const option = await screen.findByRole("option", { name: "张三" });
    fireEvent.mouseDown(option);
    expect(spy.at(-1)).toEqual([1]);
    // 受控回写后 chip 出现（label 来自添加时写入的 cache）
    expect(await screen.findByText("张三")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "移除 张三" }));
    expect(spy.at(-1)).toEqual([]);
    // chip 移除按钮消失（候选下拉里可能仍有「张三」选项，不算）
    await waitFor(() => expect(screen.queryByRole("button", { name: "移除 张三" })).toBeNull());
  });

  it("换搜索词后已选 chips 仍在", async () => {
    render(<Harness initial={[1]} />);
    expect(screen.getByText("张三")).toBeTruthy();

    const input = screen.getByLabelText("搜索客户");
    fireEvent.change(input, { target: { value: "李" } });
    await screen.findByRole("option", { name: "李四" });
    expect(screen.getByText("张三")).toBeTruthy();
  });

  it("单选模式：选中替换、× 清空", async () => {
    const spy: number[][] = [];
    render(<Harness multiple={false} initial={[1]} onChangeSpy={(ids) => spy.push(ids)} />);
    // 已有选中时单选模式不渲染搜索框
    expect(screen.queryByLabelText("搜索客户")).toBeNull();

    // × 清空
    fireEvent.click(screen.getByRole("button", { name: "移除 张三" }));
    expect(spy.at(-1)).toEqual([]);

    // 清空后搜索框回来；选李四
    const option = await screen.findByLabelText("搜索客户");
    fireEvent.change(option, { target: { value: "李" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: "李四" }));
    expect(spy.at(-1)).toEqual([2]);

    // 单选已有选中时搜索框隐藏；× 掉李四再选王五 → 替换而非追加
    fireEvent.click(screen.getByRole("button", { name: "移除 李四" }));
    expect(spy.at(-1)).toEqual([]);
    const input2 = await screen.findByLabelText("搜索客户");
    fireEvent.change(input2, { target: { value: "王" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: "王五" }));
    expect(spy.at(-1)).toEqual([3]);
  });

  it("键盘：↓ 移动高亮，Enter 选择", async () => {
    const spy: number[][] = [];
    render(<Harness onChangeSpy={(ids) => spy.push(ids)} />);
    const input = screen.getByLabelText("搜索客户");
    // 聚焦即展开（change 设相同值不触发 onChange）
    fireEvent.focus(input);
    await screen.findByRole("option", { name: "张三" });

    fireEvent.keyDown(input, { key: "ArrowDown" }); // 高亮 李四
    fireEvent.keyDown(input, { key: "Enter" });
    expect(spy.at(-1)).toEqual([2]);
  });

  it("已选项从候选中滤除；Esc 收起下拉", async () => {
    render(<Harness initial={[1]} />);
    const input = screen.getByLabelText("搜索客户");
    fireEvent.focus(input);
    await screen.findByRole("option", { name: "李四" });
    expect(screen.queryByRole("option", { name: "张三" })).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
});
