// 资料全文编辑页（/materials/:id/edit）：加载 DetailDto 渲染草稿 / 编辑-分屏-预览切换 /
// 保存 PATCH { content, updatedAt } / 409 toast 且不覆盖草稿 / 媒体类显示无正文提示 / assistant 只读。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { MaterialDetailDto } from "../src/api/types";

const textDetail: MaterialDetailDto = {
  id: 1,
  kind: "text",
  title: "复盘纪要",
  url: null,
  contentLength: 12,
  excerpt: "# 本周复盘",
  originalFilename: null,
  contentType: null,
  fileSize: null,
  isImage: false,
  deliveryId: null,
  delivery: null,
  customers: [],
  tags: [],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
  content: "# 本周复盘\n\n正文草稿",
};

const audioDetail: MaterialDetailDto = {
  ...textDetail,
  id: 2,
  kind: "audio",
  title: "线下分享音频",
  url: "https://example.com/a.mp3",
  content: null,
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockEditApi(me: Me, detail: MaterialDetailDto, opts?: { conflict?: boolean }) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url === `/api/v1/materials/${detail.id}`) {
      if (method === "GET") return { status: 200, body: { data: detail } };
      if (method === "PATCH") {
        if (opts?.conflict) {
          return { status: 409, body: { error: { code: "CONFLICT", message: "版本冲突" }, data: detail } };
        }
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...detail, ...patch, updatedAt: detail.updatedAt + 1 } } };
      }
    }
  });
  return calls;
}

describe("资料全文编辑页", () => {
  it("加载 DetailDto 渲染草稿与标题", async () => {
    mockEditApi(adminMe, textDetail);
    renderApp("/materials/1/edit");

    const textarea = (await screen.findByLabelText("正文内容")) as HTMLTextAreaElement;
    expect(textarea.value).toContain("正文草稿");
    expect(screen.getByRole("heading", { name: /复盘纪要/ })).toBeTruthy();
    // 未改动时保存不可用
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("编辑 / 分屏 / 预览三态切换", async () => {
    mockEditApi(adminMe, textDetail);
    renderApp("/materials/1/edit");
    await screen.findByLabelText("正文内容");

    // 预览：textarea 消失，markdown 渲染出标题
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.queryByLabelText("正文内容")).toBeNull();
    expect(screen.getByRole("heading", { name: "本周复盘", level: 1 })).toBeTruthy();

    // 分屏：编辑与预览并存
    fireEvent.click(screen.getByRole("button", { name: "分屏" }));
    expect(screen.getByLabelText("正文内容")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "本周复盘", level: 1 })).toBeTruthy();

    // 回编辑：预览消失
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("正文内容")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "本周复盘", level: 1 })).toBeNull();
  });

  it("保存：PATCH 带 content + updatedAt（OCC），成功后清 dirty", async () => {
    const calls = mockEditApi(adminMe, textDetail);
    renderApp("/materials/1/edit");
    const textarea = await screen.findByLabelText("正文内容");

    fireEvent.change(textarea, { target: { value: "改后的正文" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/materials/1");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body)) as Record<string, unknown>;
      expect(body).toEqual({ content: "改后的正文", updatedAt: 2000 });
    });
    expect(await screen.findByText("已保存")).toBeTruthy();
    // dirty 清除 → 保存按钮再次禁用
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("409：toast 提示冲突，本地草稿不被覆盖", async () => {
    mockEditApi(adminMe, textDetail, { conflict: true });
    renderApp("/materials/1/edit");
    const textarea = (await screen.findByLabelText("正文内容")) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "本地未保存的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("该行已被他人更新，请刷新后重试")).toBeTruthy();
    expect(textarea.value).toBe("本地未保存的草稿");
  });

  it("媒体类资料：显示无正文提示，不渲染编辑器", async () => {
    mockEditApi(adminMe, audioDetail);
    renderApp("/materials/2/edit");

    expect(await screen.findByText(/该资料为媒体类，无正文内容/)).toBeTruthy();
    expect(screen.queryByLabelText("正文内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("assistant 只读：强制预览，无保存/编辑元信息/模式切换", async () => {
    mockEditApi(assistantMe, textDetail);
    renderApp("/materials/1/edit");

    expect(await screen.findByRole("heading", { name: "本周复盘", level: 1 })).toBeTruthy();
    expect(screen.queryByLabelText("正文内容")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "编辑元信息" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分屏" })).toBeNull();
  });
});
