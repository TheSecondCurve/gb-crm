import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Pagination } from "../src/components/DataGrid/Pagination";

/** 模拟页面：page/pageSize 进 queryKey，切换即触发新查询 */
function PagedHarness({ queryFn, total }: { queryFn: (page: number, pageSize: number) => void; total: number }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  queryFn(page, pageSize);
  return (
    <Pagination
      page={page}
      pageSize={pageSize}
      total={total}
      onChange={(p, ps) => {
        setPage(p);
        setPageSize(ps);
      }}
    />
  );
}

describe("Pagination（K25）", () => {
  it("显示 共 N 条", () => {
    render(<Pagination page={1} pageSize={25} total={393} onChange={() => {}} />);
    expect(screen.getByText("共 393 条")).toBeTruthy();
  });

  it("pageSize <select> 25/50/100 切换触发新查询并回到第 1 页", () => {
    const queryFn = vi.fn();
    render(<PagedHarness queryFn={queryFn} total={393} />);

    // 先到第 2 页
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(queryFn).toHaveBeenLastCalledWith(2, 25);

    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "50" } });
    expect(queryFn).toHaveBeenLastCalledWith(1, 50);

    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "100" } });
    expect(queryFn).toHaveBeenLastCalledWith(1, 100);
  });

  it("上一页/下一页与页码导航、边界禁用", () => {
    const queryFn = vi.fn();
    render(<PagedHarness queryFn={queryFn} total={60} />);

    expect((screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(queryFn).toHaveBeenLastCalledWith(3, 25);
    // 60 / 25 = 3 页，末页下一页禁用
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(queryFn).toHaveBeenLastCalledWith(2, 25);
  });
});
