import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { ChannelDto } from "../src/api/types";

function makeChannel(partial: Partial<ChannelDto>): ChannelDto {
  return {
    id: 1,
    feishuRecordId: null,
    name: "公众号A",
    description: null,
    accountId: "gh_abc",
    registerPhone: "13900000000",
    registrant: "王某",
    realNamePerson: "王某",
    loginDevice: "iPhone",
    notes: null,
    platform: "wechat",
    channelType: "private",
    accountType: "public_account",
    status: "operating",
    followerCount: 1200,
    owners: [{ id: 1, nickname: "老王" }],
    createdAt: 1000,
    updatedAt: 2000,
    createdBy: null,
    updatedBy: null,
    ...partial,
  };
}

const channels = [
  makeChannel({ id: 1 }),
  makeChannel({ id: 2, name: "暂停的群", status: "paused", followerCount: null }),
];

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockChannelsApi(me: Me, rows: ChannelDto[] = channels) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/channels")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") {
        return { status: 201, body: { data: makeChannel({ id: 99, name: "未命名渠道" }) } };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

const headerTexts = () =>
  [...document.querySelectorAll(".data-grid-table th")].map((th) => th.textContent);

describe("渠道资产页", () => {
  it("渲染列表：名称/枚举 badge/粉丝数；暂停行 .row-disabled", async () => {
    mockChannelsApi(adminMe);
    renderApp("/channels");
    expect(await screen.findByText("公众号A")).toBeTruthy();
    expect(screen.getAllByText("微信").length).toBeGreaterThan(0); // platform badge（两行都是微信）
    expect(screen.getAllByText("运营中").length).toBeGreaterThan(0); // badge（过滤下拉里也有同名 option）
    expect(screen.getByText("1200")).toBeTruthy();
    expect(screen.getAllByText("老王").length).toBeGreaterThan(0); // 负责人展开（两行同负责人）

    const pausedRow = screen.getByText("暂停的群").closest("tr");
    expect(pausedRow?.classList.contains("row-disabled")).toBe(true);
    expect(screen.getByText("公众号A").closest("tr")?.classList.contains("row-disabled")).toBe(false);
  });

  it("q 搜索触发新 query", async () => {
    const calls = mockChannelsApi(adminMe);
    renderApp("/channels");
    await screen.findByText("公众号A");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "公众" } });
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "GET" && decodeURIComponent(c.url).includes("q=公众")),
      ).toBe(true),
    );
  });

  it("状态过滤下拉触发新 query", async () => {
    const calls = mockChannelsApi(adminMe);
    renderApp("/channels");
    await screen.findByText("公众号A");

    fireEvent.change(screen.getByLabelText("状态筛选"), { target: { value: "paused" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("status=paused"))).toBe(true));
  });

  it("pageSize 切换触发新 query", async () => {
    const calls = mockChannelsApi(adminMe);
    renderApp("/channels");
    await screen.findByText("公众号A");

    fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "100" } });
    await waitFor(() => expect(calls.some((c) => c.url.includes("pageSize=100"))).toBe(true));
  });

  it("密钥列：admin 默认可见原值；assistant 无新增/删除、密钥列默认隐藏（K27）", async () => {
    mockChannelsApi(adminMe);
    const { unmount } = renderApp("/channels");
    await screen.findByText("公众号A");
    expect(headerTexts()).toContain("账号ID");
    expect(screen.getAllByText("gh_abc").length).toBeGreaterThan(0);
    unmount();

    mockChannelsApi(assistantMe);
    renderApp("/channels");
    await screen.findByText("公众号A");
    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(headerTexts()).not.toContain("账号ID");
  });

  it("删除：ConfirmDialog → DELETE → 列表刷新", async () => {
    const calls = mockChannelsApi(adminMe);
    renderApp("/channels");
    await screen.findByText("公众号A");

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "删除渠道" });
    expect(within(dialog).getByText(/确定删除渠道「公众号A」/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/channels/1")).toBe(true),
    );
  });
});
