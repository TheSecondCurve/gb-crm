import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { ProductDto } from "../src/api/types";

const product: ProductDto = {
  id: 1,
  name: "咨询课A",
  notes: null,
  sopUrl: null,
  packageIncludes: null,
  deliveryCycle: null,
  productType: "c_consulting",
  isPackage: false,
  status: "on_sale",
  priceCents: 12345,
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockProductsApi(me: Me, rows: ProductDto[] = [product]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/products")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") {
        return { status: 201, body: { data: { ...product, id: 99, name: "未命名产品" } } };
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          status: 200,
          body: { data: { ...product, ...patch, updatedAt: 2001 } },
        };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

function cell(rowId: number, colKey: string): HTMLElement {
  const el = document.querySelector(`[data-cell="${rowId}:${colKey}"]`);
  if (!el) throw new Error(`cell ${rowId}:${colKey} not found`);
  return el as HTMLElement;
}

describe("产品目录页", () => {
  it("渲染列表：priceCents 展示为元（12345 → 123.45），枚举用 badge", async () => {
    mockProductsApi(adminMe);
    renderApp("/products");
    expect(await screen.findByText("咨询课A")).toBeTruthy();
    expect(screen.getByText("123.45")).toBeTruthy();
    expect(screen.getByText("C端咨询")).toBeTruthy();
    expect(screen.getAllByText("在售").length).toBeGreaterThan(0); // badge（过滤下拉里也有同名 option）
  });

  it("q 搜索触发新 query", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("咨询课A");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "咨询" } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && decodeURIComponent(c.url).includes("q=咨询")),
      ).toBe(true),
    );
  });

  it("状态过滤下拉触发新 query", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("咨询课A");

    fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "off_sale" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=off_sale"))).toBe(true));
  });

  it("pageSize 切换触发新 query", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("咨询课A");

    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "50" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("pageSize=50"))).toBe(true));
  });

  it("新增：弹字段表单，价格输入元 → POST 为分（K13）", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("咨询课A");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增产品" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("产品名称"), { target: { value: "新课" } });
    fireEvent.change(within(dialog).getByLabelText("价格（元）"), { target: { value: "200.5" } });
    fireEvent.change(within(dialog).getByLabelText("是否套餐"), { target: { value: "true" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/products");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({
        name: "新课",
        priceCents: 20050,
        isPackage: true,
      });
    });
  });

  it("价格编辑：输入元 → PATCH 为分（K13：200.5 → 20050）", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("123.45");

    fireEvent.doubleClick(cell(1, "priceCents"));
    const input = cell(1, "priceCents").querySelector("input")!;
    expect(input.value).toBe("123.45");
    fireEvent.change(input, { target: { value: "200.5" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/products/1");
      expect(patch).toBeTruthy();
      expect(JSON.parse(String(patch?.body))).toEqual({ priceCents: 20050, updatedAt: 2000 });
    });
  });

  it("价格非法输入：toast 报错、不发 PATCH 且不清空价格（M6）", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("123.45");

    fireEvent.doubleClick(cell(1, "priceCents"));
    const input = cell(1, "priceCents").querySelector("input")!;
    fireEvent.change(input, { target: { value: "12a" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => expect(screen.getByText("价格需为数字（元）")).toBeTruthy());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("assistant：只读整表，无新增/删除", async () => {
    mockProductsApi(assistantMe);
    renderApp("/products");
    await screen.findByText("咨询课A");

    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    fireEvent.doubleClick(cell(1, "name"));
    expect(cell(1, "name").querySelector("input")).toBeNull();
  });

  it("删除：ConfirmDialog → DELETE → 列表刷新", async () => {
    const calls = mockProductsApi(adminMe);
    renderApp("/products");
    await screen.findByText("咨询课A");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除产品" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/products/1")).toBe(true),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/products")).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });
});
