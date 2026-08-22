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
    // 表单弹窗的 relation 选项 loader（负责人 = GET /users?pageSize=100）
    if (url.startsWith("/api/v1/users")) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, nickname: "老王" },
            { id: 2, nickname: "小李" },
          ],
          meta: { page: 1, pageSize: 100, total: 2 },
        },
      };
    }
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

  it("密钥列：admin 可见原值；assistant 无新增/删除、密钥列显示「—」不可编（K27）", async () => {
    mockChannelsApi(adminMe);
    const { unmount } = renderApp("/channels");
    await screen.findByText("公众号A");
    expect(headerTexts()).toContain("账号ID");
    expect(screen.getAllByText("gh_abc").length).toBeGreaterThan(0);
    unmount();

    const masked = channels.map((c) => ({
      ...c,
      accountId: null,
      registerPhone: null,
      registrant: null,
      realNamePerson: null,
      loginDevice: null,
    }));
    mockChannelsApi(assistantMe, masked);
    renderApp("/channels");
    await screen.findByText("公众号A");
    expect(screen.queryByRole("button", { name: "新增" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    // 全部列默认展示：列头在，但 assistant 的密钥值是「—」
    expect(headerTexts()).toContain("账号ID");
    expect(screen.queryByText("gh_abc")).toBeNull();
  });

  it("新增：弹字段表单（不再直接 POST 空行），填名称后 POST /channels，Esc 可取消", async () => {
    const calls = mockChannelsApi(adminMe);
    renderApp("/channels");
    await screen.findByText("公众号A");

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog = screen.getByRole("dialog", { name: "新增渠道" });
    // 弹窗阶段不发请求
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("渠道名称"), { target: { value: "新渠道" } });
    fireEvent.change(within(dialog).getByLabelText("粉丝/好友数"), { target: { value: "500" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/channels");
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.body))).toEqual({ name: "新渠道", followerCount: 500 });
    });

    // 再开一次，Esc 关闭
    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    const dialog2 = screen.getByRole("dialog", { name: "新增渠道" });
    fireEvent.keyDown(dialog2, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "新增渠道" })).toBeNull();
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
