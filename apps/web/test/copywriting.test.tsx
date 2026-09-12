// 文案工作台（K60）：tab 渲染（提示词配置仅 admin）/ 生成 tab 模板填充 + topic 必填 + generate → 自动逆向检查 →
// 修订稿+原始稿 / 手动审计报告 / 行内保存（标题必填）/ 提示词配置 PATCH 变更键 + 还原默认 / 已保存 tab assistant 只读 / 模板管理。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { CopyItemDto, CopyTemplateDto } from "../src/api/types";

interface Call {
  url: string;
  method: string;
  body?: string;
}

const promptsConfig = {
  generateSystemPrompt: "自定义生成PROMPT",
  auditSystemPrompt: "自定义审计PROMPT",
  reviewSystemPrompt: "自定义逆向PROMPT",
  customized: true,
  updatedAt: 1000,
  updatedBy: 1,
};

const copyLlmConfig = {
  provider: "deepseek",
  baseUrl: "https://copy.example/v1",
  model: "copy-model",
  apiKeySet: true,
  apiKeyMasked: "sk-a…wxyz",
  dedicatedReady: true,
  updatedAt: 1000,
  updatedBy: 1,
};

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
    if (url.startsWith("/api/v1/system/copywriting-prompts")) {
      return { status: 200, body: { data: promptsConfig } };
    }
    if (url.startsWith("/api/v1/system/copywriting-llm")) {
      return { status: 200, body: { data: copyLlmConfig } };
    }
    if (url.startsWith("/api/v1/copywriting/templates") && method === "GET") {
      // 生成 tab 拉启用模板（?enabled=true）；模板管理 tab 全量
      const data = url.includes("enabled=true") ? templates.filter((t) => t.enabled) : templates;
      return { status: 200, body: { data, meta: { page: 1, pageSize: data.length, total: data.length } } };
    }
    if (url === "/api/v1/copywriting/generate" && method === "POST") {
      return { status: 200, body: { data: { title: "开营推文", content: "生成的文案正文" } } };
    }
    if (url === "/api/v1/copywriting/review" && method === "POST") {
      return { status: 200, body: { data: { title: "修订后标题", content: "修订后的正文" } } };
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
  it("渲染 tab：admin 四个（含「提示词配置」）；assistant 没有「提示词配置」", async () => {
    mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    expect(await screen.findByRole("heading", { name: "文案工作台" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "生成与审计" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "已保存文案" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "模板管理" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "提示词配置" })).toBeTruthy();
  });

  it("非 admin（assistant）不显示「提示词配置」tab；?tab=prompts 回落生成与审计", async () => {
    mockCopywritingApi(assistantMe);
    renderApp("/copywriting?tab=prompts");

    expect(await screen.findByRole("tab", { name: "生成与审计" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "提示词配置" })).toBeNull();
  });

  it("提示词配置（?tab=prompts，admin）：预填生效 prompt；改动 PATCH 只带变更键；还原默认 PATCH null", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting?tab=prompts");

    const tab = await screen.findByRole("tab", { name: "提示词配置" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const genTa = (await screen.findByDisplayValue("自定义生成PROMPT")) as HTMLTextAreaElement;
    expect(genTa).toBeTruthy();
    expect((await screen.findByDisplayValue("自定义审计PROMPT")) as HTMLTextAreaElement).toBeTruthy();
    expect((await screen.findByDisplayValue("自定义逆向PROMPT")) as HTMLTextAreaElement).toBeTruthy();

    // 页内有两个「保存配置」（提示词 + 专用 LLM），提示词表单按卡片 scoped
    const promptsCard = screen.getByRole("heading", { name: "文案工作台提示词" }).closest(".card") as HTMLElement;

    fireEvent.change(genTa, { target: { value: "改成新的生成 PROMPT" } });
    fireEvent.click(within(promptsCard).getByRole("button", { name: "保存配置" }));
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/system/copywriting-prompts");
      expect(p).toBeTruthy();
      expect(JSON.parse(String(p?.body))).toEqual({ generateSystemPrompt: "改成新的生成 PROMPT" });
    });

    fireEvent.click(within(promptsCard).getByRole("button", { name: "还原默认" }));
    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.method === "PATCH" && c.url === "/api/v1/system/copywriting-prompts",
      );
      expect(JSON.parse(String(patches[patches.length - 1]?.body))).toEqual({
        generateSystemPrompt: null,
        auditSystemPrompt: null,
        reviewSystemPrompt: null,
      });
    });
  });

  it("提示词配置：文案专用 LLM 卡片预填 + badge；测试连接 POST 现值；保存 PATCH 变更键", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting?tab=prompts");

    // 预填 + 已启用 badge
    expect(await screen.findByDisplayValue("https://copy.example/v1")).toBeTruthy();
    expect(screen.getByDisplayValue("copy-model")).toBeTruthy();
    expect(screen.getByText("已启用：文案调用走此配置")).toBeTruthy();
    const llmCard = screen.getByRole("heading", { name: "文案专用 LLM（可选）" }).closest(".card") as HTMLElement;

    // 改模型 + 输入新 key → 测试连接：POST 表单现值（provider 未改也带上非空现值）
    fireEvent.change(screen.getByPlaceholderText("如 deepseek-chat"), { target: { value: "copy-model-v2" } });
    fireEvent.change(screen.getByPlaceholderText(/已保存/), { target: { value: "sk-new-key" } });
    fireEvent.click(within(llmCard).getByRole("button", { name: "测试连接" }));
    await waitFor(() => {
      const t = calls.find((c) => c.method === "POST" && c.url === "/api/v1/system/copywriting-llm/test");
      expect(t).toBeTruthy();
      expect(JSON.parse(String(t?.body))).toEqual({
        provider: "deepseek",
        baseUrl: "https://copy.example/v1",
        model: "copy-model-v2",
        apiKey: "sk-new-key",
      });
    });

    // 保存：apiKey 保留语义（表单清空后保存不带 apiKey）
    fireEvent.change(screen.getByPlaceholderText(/已保存/), { target: { value: "" } });
    fireEvent.click(within(llmCard).getByRole("button", { name: "保存配置" }));
    await waitFor(() => {
      const p = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/system/copywriting-llm");
      expect(p).toBeTruthy();
      expect(JSON.parse(String(p?.body))).toEqual({ model: "copy-model-v2" });
    });
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

  it("生成 tab：generate → 自动逆向检查 → 修订稿在编辑框、原始稿留档；audit → 显示结论与 issues", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    fireEvent.change(await screen.findByLabelText("主题内容"), { target: { value: "开营预告" } });
    fireEvent.click(screen.getByRole("button", { name: "生成文案" }));

    // 修订稿才是产出：正文/标题编辑框显示修订结果
    const contentBox = (await screen.findByLabelText("文案正文")) as HTMLTextAreaElement;
    expect(contentBox.value).toBe("修订后的正文");
    expect((screen.getByLabelText("文案标题") as HTMLInputElement).value).toBe("修订后标题");

    // 原始稿折叠留档 + 两次 LLM 调用（generate + review）
    expect(screen.getByText("生成的文案正文")).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/copywriting/generate")).toBe(true);
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/copywriting/review")).toBe(true);
    });
    const gen = calls.find((c) => c.method === "POST" && c.url === "/api/v1/copywriting/generate");
    expect(JSON.parse(String(gen?.body))).toEqual({ topic: "开营预告" }); // 内置默认 → 不带 systemPrompt
    const rev = calls.find((c) => c.method === "POST" && c.url === "/api/v1/copywriting/review");
    const revBody = JSON.parse(String(rev?.body));
    expect(revBody.title).toBe("开营推文");
    expect(revBody.content).toBe("生成的文案正文");

    fireEvent.click(screen.getByRole("button", { name: "AI 审计" }));
    expect(await screen.findByText("注意")).toBeTruthy();
    expect(screen.getByText("整体可读，但行动号召偏弱。")).toBeTruthy();
    expect(screen.getByText("行动号召")).toBeTruthy();
    expect(screen.getByText(/补充报名方式/)).toBeTruthy();
  });

  it("生成 tab：关闭自动逆向检查 → 只调 generate，结果即原始稿", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    fireEvent.change(await screen.findByLabelText("主题内容"), { target: { value: "开营预告" } });
    fireEvent.click(screen.getByLabelText("生成后自动逆向检查")); // 取消勾选
    fireEvent.click(screen.getByRole("button", { name: "生成文案" }));

    const contentBox = (await screen.findByLabelText("文案正文")) as HTMLTextAreaElement;
    expect(contentBox.value).toBe("生成的文案正文");
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/copywriting/generate")).toBe(true);
    });
    expect(calls.some((c) => c.url === "/api/v1/copywriting/review")).toBe(false);
  });

  it("保存：标题为空提示且不发请求；补标题后 POST items（title + 修订稿 content）", async () => {
    const calls = mockCopywritingApi(adminMe);
    renderApp("/copywriting");

    fireEvent.change(await screen.findByLabelText("主题内容"), { target: { value: "开营预告" } });
    fireEvent.click(screen.getByRole("button", { name: "生成文案" }));
    await screen.findByLabelText("文案正文");

    // 标题清空（只剩空白）→ 提示且不发请求
    fireEvent.change(screen.getByLabelText("文案标题"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "保存文案" }));
    expect(await screen.findByText("请填写标题后再保存")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/copywriting/items")).toBe(false);

    // 补标题 → POST items
    fireEvent.change(screen.getByLabelText("文案标题"), { target: { value: "开营推文" } });
    fireEvent.click(screen.getByRole("button", { name: "保存文案" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/copywriting/items");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body));
      expect(body.title).toBe("开营推文");
      expect(body.content).toBe("修订后的正文");
      expect(body.topic).toBe("开营预告");
    });
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

  it("模板管理：六维度分组卡片，自定义模板可编辑/删除", async () => {
    mockCopywritingApi(adminMe);
    renderApp("/copywriting?tab=templates");

    // 六段内容维度分组（行数据异步加载，findBy* 等待）
    expect(await screen.findByRole("heading", { name: "业务背景" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "主题内容" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "润色要求" })).toBeTruthy();
    await screen.findByText("女商品牌背景");

    // 自定义行（业务背景/主题内容）有编辑/删除
    expect(screen.getAllByRole("button", { name: "编辑" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "删除" }).length).toBeGreaterThan(0);
  });
});
