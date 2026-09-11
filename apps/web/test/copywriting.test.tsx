// 文案工作台（K60）：三 tab 渲染 / 生成 tab 模板填充 + topic 必填 + generate/audit /
// 已保存 tab 列表 + assistant 只读。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { CopyItemDto, CopyTemplateDto } from "../src/api/types";

interface Call {
  url: string;
  method: string;
  body?: string;
}

const templates: CopyTemplateDto[] = [
  { id: 1, dimension: "background", name: "女商品牌背景", content: "我们是女商团队……", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
  { id: 2, dimension: "topic", name: "活动预告", content: "活动预告模板正文", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
];

const auditReport = {
  verdict: "warn",
  summary: "整体可读，但行动号召偏弱。",
  issues: [
    { aspect: "行动号召", detail: "结尾缺少明确引导", suggestion: "补充报名方式" },
  ],
};

const items: CopyItemDto[] = [
  {
    id: 1,
    title: "开营朋友圈文案",
    background: null,
    audience: null,
    topic: "开营",
    goal: null,
    outputType: "朋友圈",
    polish: null,
    content: "各位好，开营啦",
    auditReport: JSON.stringify(auditReport),
    createdAt: 1000,
    updatedAt: 2000,
    createdBy: null,
    updatedBy: null,
  },
];

function mockCopywritingApi(me: Me) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url.startsWith("/api/v1/copywriting/templates") && method === "GET") {
      // 生成 tab 拉启用模板（?enabled=true）；模板管理 tab 全量
      const data = url.includes("enabled=true") ? templates.filter((t) => t.enabled) : templates;
      return { status: 200, body: { data, meta: { page: 1, pageSize: data.length, total: data.length } } };
    }
    if (url === "/api/v1/copywriting/generate" && method === "POST") {
      return { status: 200, body: { data: { content: "生成的文案正文" } } };
    }
    if (url === "/api/v1/copywriting/audit" && method === "POST") {
      return { status: 200, body: { data: auditReport } };
    }
    if (url.startsWith("/api/v1/copywriting/items")) {
      if (method === "GET") {
        return { status: 200, body: { data: items, meta: { page: 1, pageSize: 25, total: items.length } } };
      }
      if (method === "POST") return { status: 201, body: { data: items[0] } };
      if (method === "PATCH") return { status: 200, body: { data: items[0] } };
      if (method === "DELETE") return { status: 204 };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return calls;
}

describe("文案工作台", () => {
  it("渲染三个 tab", async () => {
    mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    expect(await screen.findByRole("heading", { name: "文案工作台" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "生成与审计" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "已保存文案" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "模板管理" })).toBeTruthy();
  });

  it("生成 tab：选择模板后 textarea 填入模板正文；切回自定义不动文本", async () => {
    mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    const select = await screen.findByLabelText("业务背景模板");
    await waitFor(() => expect(within(select).getByText("女商品牌背景")).toBeTruthy());

    const textarea = screen.getByLabelText("业务背景") as HTMLTextAreaElement;
    fireEvent.change(select, { target: { value: "1" } });
    expect(textarea.value).toBe("我们是女商团队……");

    // 手动改过之后切回「自定义」不动文本
    fireEvent.change(textarea, { target: { value: "手写背景" } });
    fireEvent.change(select, { target: { value: "" } });
    expect(textarea.value).toBe("手写背景");
  });

  it("生成 tab：主题内容为空时「生成文案」禁用且不发请求", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    const button = await screen.findByRole("button", { name: "生成文案" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(calls.some((c) => c.url === "/api/v1/copywriting/generate")).toBe(false);
  });

  it("生成 tab：mock generate 成功 → 结果区显示文案；audit 成功 → 显示结论与 issues", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    fireEvent.change(await screen.findByLabelText("主题内容"), { target: { value: "开营预告" } });
    fireEvent.click(screen.getByRole("button", { name: "生成文案" }));
    expect(await screen.findByText("生成的文案正文")).toBeTruthy();
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/copywriting/generate");
      expect(JSON.parse(String(post?.body))).toEqual({ topic: "开营预告" });
    });

    fireEvent.click(screen.getByRole("button", { name: "AI 审计" }));
    expect(await screen.findByText("注意")).toBeTruthy();
    expect(screen.getByText("整体可读，但行动号召偏弱。")).toBeTruthy();
    expect(screen.getByText("行动号召")).toBeTruthy();
    expect(screen.getByText(/补充报名方式/)).toBeTruthy();
  });

  it("已保存 tab：列表渲染；assistant 只有「查看」无编辑/删除", async () => {
    mockCopywritingApi(assistantMe);
    renderApp("/copywriting?tab=saved");

    expect(await screen.findByText("开营朋友圈文案")).toBeTruthy();
    expect(screen.getByText("朋友圈")).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("已保存 tab：admin 可删除（ConfirmDialog → DELETE）", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting?tab=saved");

    expect(await screen.findByText("开营朋友圈文案")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const confirm = screen.getByRole("dialog", { name: "删除文案" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/copywriting/items/1")).toBe(true),
    );
  });
});
