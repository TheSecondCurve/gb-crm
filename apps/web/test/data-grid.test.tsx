import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/client";
import { DataGrid, type GridColumn } from "../src/components/DataGrid/DataGrid";
import { ToastProvider } from "../src/components/Toast";

interface Row {
  id: number;
  updatedAt: number;
  nickname: string;
  phone: string;
  customerType: string;
  multiCodes: string[];
  ownerIds: number[];
  notes: string;
}

const row1: Row = {
  id: 1,
  updatedAt: 100,
  nickname: "张三",
  phone: "138",
  customerType: "customer",
  multiCodes: ["vip"],
  ownerIds: [1],
  notes: "",
};
const row2: Row = { ...row1, id: 2, updatedAt: 100, nickname: "李四", phone: "139" };

const columns: GridColumn<Row>[] = [
  { key: "nickname", label: "昵称", editor: "text", editable: true },
  { key: "phone", label: "手机号", editor: "text", editable: true },
  {
    key: "customerType",
    label: "类型",
    editor: "select",
    editable: true,
    options: [
      { value: "customer", label: "客户" },
      { value: "partner", label: "合作伙伴" },
    ],
  },
  {
    key: "multiCodes",
    label: "标签",
    editor: "multi",
    editable: true,
    options: [
      { value: "vip", label: "VIP" },
      { value: "ip", label: "IP" },
    ],
  },
  {
    key: "ownerIds",
    label: "归属人",
    editor: "relation",
    editable: true,
    relationLoader: (search) =>
      Promise.resolve(
        [
          { id: 1, label: "王五" },
          { id: 2, label: "赵六" },
        ].filter((o) => o.label.includes(search)),
      ),
  },
  { key: "notes", label: "备注", editor: "textarea", editable: true },
  { key: "updatedAt", label: "更新时间", editable: false },
];

type PatchFn = (id: number, body: Record<string, unknown>) => Promise<Row>;

/** 手动控制 resolve/reject 的 patchRow */
function makePatchRow() {
  const calls: Array<{ id: number; body: Record<string, unknown> }> = [];
  const waiters: Array<{ resolve: (row: Row) => void; reject: (err: unknown) => void }> = [];
  const patchRow = vi.fn<PatchFn>((id, body) => {
    calls.push({ id, body });
    return new Promise<Row>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  });
  return { patchRow, calls, waiters };
}

function setup(patchRow: PatchFn, rows: Row[] = [row1, row2]) {
  const seed = { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  function Harness() {
    const { data } = useQuery({
      queryKey: ["rows"],
      queryFn: () => Promise.resolve(seed),
      initialData: seed,
    });
    return (
      <DataGrid gridId="test-grid" columns={columns} rows={data.data} queryKey={["rows"]} patchRow={patchRow} />
    );
  }
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

function cell(rowId: number, colKey: string): HTMLElement {
  const el = document.querySelector(`[data-cell="${rowId}:${colKey}"]`);
  if (!el) throw new Error(`cell ${rowId}:${colKey} not found`);
  return el as HTMLElement;
}

function cellInput(rowId: number, colKey: string): HTMLInputElement {
  const input = cell(rowId, colKey).querySelector("input");
  if (!input) throw new Error(`no editor in ${rowId}:${colKey}`);
  return input as HTMLInputElement;
}

describe("DataGrid 选中与进入编辑", () => {
  it("单击选中但不进入编辑", () => {
    setup(vi.fn<PatchFn>());
    fireEvent.click(cell(1, "nickname"));
    expect(cell(1, "nickname").className).toContain("cell-selected");
    expect(cell(1, "nickname").querySelector("input")).toBeNull();
  });

  it("双击进入编辑", () => {
    setup(vi.fn<PatchFn>());
    fireEvent.doubleClick(cell(1, "nickname"));
    expect(cellInput(1, "nickname").value).toBe("张三");
  });

  it("选中后按 Enter 进入编辑", () => {
    setup(vi.fn<PatchFn>());
    fireEvent.click(cell(1, "nickname"));
    fireEvent.keyDown(cell(1, "nickname"), { key: "Enter" });
    expect(cellInput(1, "nickname").value).toBe("张三");
  });

  it("editable=false 的格双击无编辑器", () => {
    setup(vi.fn<PatchFn>());
    fireEvent.doubleClick(cell(1, "updatedAt"));
    expect(cell(1, "updatedAt").querySelector("input,select,textarea")).toBeNull();
  });
});

describe("DataGrid 提交与取消", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("Esc 取消且不发 PATCH（debounce 也被取消）", () => {
    const { patchRow } = makePatchRow();
    setup(patchRow);
    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "改" } });
    fireEvent.keyDown(cellInput(1, "nickname"), { key: "Escape" });
    expect(cell(1, "nickname").querySelector("input")).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(patchRow).not.toHaveBeenCalled();
  });

  it("文本 300ms debounce：快打字只发一次", () => {
    const { patchRow } = makePatchRow();
    setup(patchRow);
    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "张" } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "张三三" } });
    act(() => vi.advanceTimersByTime(299));
    expect(patchRow).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(patchRow).toHaveBeenCalledWith(1, { nickname: "张三三", updatedAt: 100 });
  });
});

describe("DataGrid select / multi / relation 立即入队", () => {
  it("select 变更立即发 PATCH，无 debounce", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    setup(patchRow);
    fireEvent.doubleClick(cell(1, "customerType"));
    fireEvent.change(cell(1, "customerType").querySelector("select")!, {
      target: { value: "partner" },
    });
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toEqual({ customerType: "partner", updatedAt: 100 });
    await act(async () => waiters[0]!.resolve({ ...row1, customerType: "partner", updatedAt: 101 }));
  });

  it("multi 勾选立即入队", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    setup(patchRow, [row1]);
    fireEvent.doubleClick(cell(1, "multiCodes"));
    fireEvent.click(screen.getByLabelText("IP"));
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toEqual({ multiCodes: ["vip", "ip"], updatedAt: 100 });
    await act(async () => waiters[0]!.resolve({ ...row1, multiCodes: ["vip", "ip"], updatedAt: 101 }));
  });

  it("relation 可搜索多选立即入队", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    setup(patchRow, [row1]);
    fireEvent.doubleClick(cell(1, "ownerIds"));
    expect(await screen.findByLabelText("赵六")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("赵六"));
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toEqual({ ownerIds: [1, 2], updatedAt: 100 });
    await act(async () => waiters[0]!.resolve({ ...row1, ownerIds: [1, 2], updatedAt: 101 }));
  });
});

describe("DataGrid 键盘导航与行内串行 PATCH（design.md §8）", () => {
  it("Tab 连续改两格：两次 PATCH 串行，第二次 updatedAt = 第一次响应", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    setup(patchRow, [row1]);

    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "新昵称" } });
    fireEvent.keyDown(cellInput(1, "nickname"), { key: "Tab" });

    // 第一格立即发出（debounce 被 flush）
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(calls[0]!).toEqual({ id: 1, body: { nickname: "新昵称", updatedAt: 100 } });

    // Tab 右移直接进入手机号编辑；改完再 Tab
    fireEvent.change(cellInput(1, "phone"), { target: { value: "139000" } });
    fireEvent.keyDown(cellInput(1, "phone"), { key: "Tab" });

    // 第一个还没 200：不并行
    expect(patchRow).toHaveBeenCalledTimes(1);

    await act(async () => waiters[0]!.resolve({ ...row1, nickname: "新昵称", updatedAt: 101 }));
    expect(patchRow).toHaveBeenCalledTimes(2);
    expect(calls[1]!).toEqual({ id: 1, body: { phone: "139000", updatedAt: 101 } });

    await act(async () => waiters[1]!.resolve({ ...row1, nickname: "新昵称", phone: "139000", updatedAt: 102 }));
  });

  it("未等 200 就连续改两格：pending 合并为一个 PATCH，不并行", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    setup(patchRow, [row1]);

    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "A" } });
    fireEvent.keyDown(cellInput(1, "nickname"), { key: "Tab" });
    expect(patchRow).toHaveBeenCalledTimes(1);

    // inflight 期间改 phone（Tab 入队）再改类型（select 立即入队）→ 合并
    fireEvent.change(cellInput(1, "phone"), { target: { value: "P" } });
    fireEvent.keyDown(cellInput(1, "phone"), { key: "Tab" });
    fireEvent.change(cell(1, "customerType").querySelector("select")!, {
      target: { value: "partner" },
    });
    expect(patchRow).toHaveBeenCalledTimes(1);

    await act(async () => waiters[0]!.resolve({ ...row1, nickname: "A", updatedAt: 101 }));
    expect(patchRow).toHaveBeenCalledTimes(2);
    expect(calls[1]!.body).toEqual({ phone: "P", customerType: "partner", updatedAt: 101 });
    await act(async () => waiters[1]!.resolve({ ...row1, updatedAt: 102 }));
  });

  it("Enter flush 并下移（不进入下一格编辑，焦点落到目标格）", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    setup(patchRow);
    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "改" } });
    fireEvent.keyDown(cellInput(1, "nickname"), { key: "Enter" });

    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toEqual({ nickname: "改", updatedAt: 100 });
    expect(cell(1, "nickname").querySelector("input")).toBeNull();
    expect(cell(2, "nickname").className).toContain("cell-selected");
    expect(document.activeElement).toBe(cell(2, "nickname"));
    // 下移后未进入编辑
    expect(cell(2, "nickname").querySelector("input")).toBeNull();

    await act(async () => waiters[0]!.resolve({ ...row1, nickname: "改", updatedAt: 101 }));
  });

  it("Shift+Tab 左移并进入上一格编辑", async () => {
    const { patchRow, waiters } = makePatchRow();
    setup(patchRow, [row1]);
    fireEvent.doubleClick(cell(1, "phone"));
    fireEvent.change(cellInput(1, "phone"), { target: { value: "P" } });
    fireEvent.keyDown(cellInput(1, "phone"), { key: "Tab", shiftKey: true });

    expect(cellInput(1, "nickname")).toBeTruthy();
    expect(document.activeElement).toBe(cellInput(1, "nickname"));
    expect(patchRow).toHaveBeenCalledWith(1, { phone: "P", updatedAt: 100 });
    await act(async () => waiters[0]!.resolve({ ...row1, phone: "P", updatedAt: 101 }));
  });
});

describe("DataGrid flush / 409 / cache", () => {
  it("unmount：取消 debounce 并立即发出 PATCH", async () => {
    const { patchRow, calls, waiters } = makePatchRow();
    const { unmount } = setup(patchRow, [row1]);
    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "卸载前" } });

    unmount();
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toEqual({ nickname: "卸载前", updatedAt: 100 });
    await act(async () => waiters[0]!.resolve({ ...row1, nickname: "卸载前", updatedAt: 101 }));
  });

  it("409：整行替换 cache、丢弃 pending、Toast「该行已被他人更新」", async () => {
    const { patchRow, waiters } = makePatchRow();
    const { queryClient } = setup(patchRow, [row1]);

    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "我的" } });
    fireEvent.keyDown(cellInput(1, "nickname"), { key: "Tab" });
    // inflight 期间再改一格（将被 409 丢弃）
    fireEvent.change(cellInput(1, "phone"), { target: { value: "丢" } });
    fireEvent.keyDown(cellInput(1, "phone"), { key: "Tab" });

    const serverRow: Row = { ...row1, nickname: "别人的", phone: "000", updatedAt: 200 };
    await act(async () =>
      waiters[0]!.reject(new ApiError(409, "CONFLICT", "冲突", serverRow)),
    );

    expect(patchRow).toHaveBeenCalledTimes(1); // pending 不再发
    expect(screen.getByText("该行已被他人更新")).toBeTruthy();
    const cached = queryClient.getQueryData<{ data: Row[] }>(["rows"]);
    expect(cached?.data[0]).toEqual(serverRow);
    expect(cell(1, "nickname").textContent).toBe("别人的");
  });

  it("乐观更新：入队即改 cache，UI 先变", async () => {
    const { patchRow } = makePatchRow();
    const { queryClient } = setup(patchRow, [row1]);
    fireEvent.doubleClick(cell(1, "nickname"));
    fireEvent.change(cellInput(1, "nickname"), { target: { value: "乐观" } });
    fireEvent.keyDown(cellInput(1, "nickname"), { key: "Enter" });
    const cached = queryClient.getQueryData<{ data: Row[] }>(["rows"]);
    expect(cached?.data[0]?.nickname).toBe("乐观");
    // react-query 的 observer 通知走调度队列，测试环境需让出一个 tick 才会重渲染
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(cell(1, "nickname").textContent).toBe("乐观");
  });
});

describe("DataGrid 列选择器与状态", () => {
  it("默认展示全部列", () => {
    const headerTexts = () =>
      [...document.querySelectorAll(".data-grid-table th")].map((th) => th.textContent);
    setup(vi.fn<PatchFn>());
    expect(headerTexts()).toEqual(["昵称", "手机号", "类型", "标签", "归属人", "备注", "更新时间"]);
  });

  it("隐藏/显示列并持久化 localStorage（按 gridId 命名空间）", () => {
    // 列设置面板里的 label 与表头同名，表头断言必须限定在 .data-grid-table th 内
    const headerTexts = () =>
      [...document.querySelectorAll(".data-grid-table th")].map((th) => th.textContent);

    const { unmount } = setup(vi.fn<PatchFn>());
    expect(headerTexts()).toContain("手机号");

    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(screen.getByLabelText("手机号"));
    expect(headerTexts()).not.toContain("手机号");
    expect(JSON.parse(localStorage.getItem("gb-crm:datagrid:test-grid:columns")!)).toEqual([
      "nickname",
      "customerType",
      "multiCodes",
      "ownerIds",
      "notes",
      "updatedAt",
    ]);

    unmount();
    setup(vi.fn<PatchFn>());
    expect(headerTexts()).not.toContain("手机号"); // 重新挂载仍隐藏
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(screen.getByLabelText("手机号"));
    expect(headerTexts()).toContain("手机号");
  });

  it("冻结首列不可隐藏", () => {
    setup(vi.fn<PatchFn>());
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    const checkbox = screen.getByLabelText("昵称");
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  });

  it("空态 .empty 与加载态", () => {
    const { unmount } = setup(vi.fn<PatchFn>(), []);
    expect(document.querySelector(".empty")?.textContent).toBe("暂无数据");
    unmount();

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <DataGrid
            gridId="g2"
            columns={columns}
            rows={[]}
            loading
            queryKey={["rows"]}
            patchRow={vi.fn<PatchFn>()}
          />
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(document.querySelector(".empty")?.textContent).toBe("加载中…");
  });
});
