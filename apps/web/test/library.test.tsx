// 素材库（K63）：文件夹树 + 相册卡片（缩略图/尺寸徽标/AI 状态/描述/归档路径）+
// folderId/tagNames 过滤参数 + 多文件上传（FormData 串行）+ 多选批量移动 + 重跑识别 + assistant 只读。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { MaterialDto } from "../src/api/types";

interface Call {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

const folders = [
  { id: 5, name: "活动素材", parentId: null, path: "活动素材", materialCount: 1, createdAt: 1, updatedAt: 1 },
  { id: 6, name: "下午茶", parentId: 5, path: "活动素材/下午茶", materialCount: 1, createdAt: 1, updatedAt: 1 },
];

const img1: MaterialDto = {
  id: 3,
  kind: "file",
  title: "现场合影",
  url: null,
  contentLength: 0,
  excerpt: null,
  originalFilename: "合影.png",
  contentType: "image/png",
  fileSize: 2048,
  isImage: true,
  description: "下午茶第一排大合影",
  folderId: 5,
  folder: { id: 5, name: "活动素材", path: "活动素材" },
  imageWidth: 3024,
  imageHeight: 4032,
  checksum: null,
  aiStatus: "ready",
  enrichedAt: 9000,
  deliveryId: null,
  delivery: null,
  customers: [],
  tags: [{ id: 1, name: "海报" }],
  createdAt: 1000,
  updatedAt: 4000,
  createdBy: null,
  updatedBy: null,
};

const failedImg: MaterialDto = {
  ...img1,
  id: 4,
  title: "失败的那张",
  originalFilename: "bad.png",
  description: null,
  folderId: null,
  folder: null,
  aiStatus: "failed",
  enrichedAt: null,
  tags: [],
  updatedAt: 5000,
};

function mockLibraryApi(me: Me, rows: MaterialDto[] = [img1]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    if (url === "/api/v1/material-folders") return { status: 200, body: { data: folders } };
    if (url.startsWith("/api/v1/tags")) {
      return {
        status: 200,
        body: { data: [{ id: 1, name: "海报", domain: "material", scope: "other", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null }], meta: { page: 1, pageSize: 100, total: 1 } },
      };
    }
    if (url.startsWith("/api/v1/materials")) {
      return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
    }
    if (url === "/api/v1/materials/3" && method === "GET") {
      return { status: 200, body: { data: { ...img1, content: null } } };
    }
    if (url === "/api/v1/materials/3/enrich" && method === "POST") return { status: 200, body: { data: { id: 3, aiStatus: "pending" } } };
    return { status: 200, body: { data: [] } };
  });
  return calls;
}

describe("素材库（K63）", () => {
  it("渲染：文件夹树（含未分类/缩进层级）+ 卡片（缩略图/尺寸/AI 状态/描述/归档路径/下载）；请求带 kind=file", async () => {
    const calls = mockLibraryApi(adminMe);
    renderApp("/library");

    await screen.findByAltText("合影.png");
    const listCall = calls.find((c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?"));
    expect(listCall?.url).toContain("kind=file");

    // 文件夹树
    expect(screen.getByRole("button", { name: /全部素材/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "未分类" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /活动素材（1）/ })).toBeTruthy();
    const sub = screen.getByRole("button", { name: /下午茶（1）/ });
    expect(sub.style.paddingLeft).toBe("22px"); // 二级缩进

    // 卡片元数据
    const img = screen.getByAltText("合影.png");
    expect(img.getAttribute("src")).toBe("/api/v1/materials/3/file");
    expect(screen.getByText("3024×4032")).toBeTruthy();
    expect(screen.getByText("下午茶第一排大合影")).toBeTruthy();
    expect(screen.getByText(/活动素材$/)).toBeTruthy(); // 归档路径
    expect(screen.getByText("已识别")).toBeTruthy(); // AI 状态
    expect(screen.getByRole("link", { name: "下载" }).getAttribute("href")).toBe(
      "/api/v1/materials/3/file?download=1",
    );
  });

  it("过滤：选文件夹 → folderId=5；点标签 chip → tagNames=海报；未分类 → folderId=0", async () => {
    const calls = mockLibraryApi(adminMe);
    renderApp("/library");
    await screen.findByAltText("合影.png");

    fireEvent.click(screen.getByRole("button", { name: /活动素材（1）/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("folderId=5"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "未分类" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("folderId=0"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "海报" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("tagNames") && c.url.includes("%E6%B5%B7%E6%8A%A5"))).toBe(true);
    });
  });

  it("多文件上传：串行 POST /materials/upload，FormData 带 title 与当前 folderId；重复软提示", async () => {
    const calls = mockLibraryApi(adminMe);
    const { container } = renderApp("/library");
    await screen.findByAltText("合影.png");

    // 选中文件夹后上传归档进去
    fireEvent.click(screen.getByRole("button", { name: /活动素材（1）/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("folderId=5"))).toBe(true);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const fileA = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    const fileB = new File([new Uint8Array([2])], "b.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [fileA, fileB] } });

    await waitFor(() => {
      const uploads = calls.filter((c) => c.method === "POST" && c.url === "/api/v1/materials/upload");
      expect(uploads).toHaveLength(2);
      expect(uploads[0]!.body.get("title")).toBe("a");
      expect(uploads[0]!.body.get("folderId")).toBe("5");
    });
  });

  it("多选批量：勾选两张 → 移入文件夹下拉 → 每行 PATCH folderId + updatedAt", async () => {
    const calls = mockLibraryApi(adminMe, [img1, failedImg]);
    renderApp("/library");
    await screen.findByAltText("合影.png");

    const checks = screen.getAllByLabelText("选择");
    fireEvent.click(checks[0]!);
    fireEvent.click(checks[1]!);
    const bar = await screen.findByRole("toolbar", { name: "批量操作" });
    expect(within(bar).getByText(/已选 2 项/)).toBeTruthy();

    fireEvent.change(within(bar).getByLabelText("移入文件夹"), { target: { value: "6" } });
    await waitFor(() => {
      const patches = calls.filter(
        (c) => c.method === "PATCH" && /^\/api\/v1\/materials\/\d+$/.test(c.url),
      );
      expect(patches).toHaveLength(2);
      expect(
        patches.every((c) => {
          const body = JSON.parse(String(c.body));
          return body.folderId === 6 && typeof body.updatedAt === "number";
        }),
      ).toBe(true);
    });
  });

  it("识别失败卡片：显示「重跑识别」→ POST /materials/:id/enrich；已识别卡片无此按钮", async () => {
    const calls = mockLibraryApi(adminMe, [img1, failedImg]);
    renderApp("/library");
    await screen.findByText("失败的那张");

    const rerun = screen.getByRole("button", { name: /重跑识别/ });
    expect(rerun).toBeTruthy();
    fireEvent.click(rerun);
    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/materials/4/enrich")).toBe(true);
    });
    // 只有失败卡有重跑（ready 的那张没有）
    expect(screen.getAllByRole("button", { name: /重跑识别/ })).toHaveLength(1);
  });

  it("assistant 只读：无上传/新增/选择框/修改/删除/重跑，仅查看与下载", async () => {
    mockLibraryApi(assistantMe, [img1, failedImg]);
    renderApp("/library");
    await screen.findByAltText("合影.png");

    expect(screen.queryByRole("button", { name: /上传图片/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "新增素材" })).toBeNull();
    expect(screen.queryByLabelText("选择")).toBeNull();
    expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("button", { name: /重跑识别/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "查看" }).length).toBe(2);
    expect(screen.getAllByRole("link", { name: "下载" }).length).toBe(2);
  });
});
