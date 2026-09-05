// 资料专区（K54）：列表渲染 / q+kind+orphan 请求参数 / 按关联交付类型分组 tab（deliveryKind）/
// 新增（kind 切换显隐）/ 修改 OCC / assistant 只读 / 查看全文。
// K58：标签列 / 标签筛选下拉（tagId）/ 表单词表选词 + newTagNames 新词 / 编辑清空标签。
// 文件专区 tab：kind=file album 格子 / 图片缩略图 / 非图片占位 + 文件名 + 下载链接 / 专辑内搜索。
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { adminMe, assistantMe, mockFetch, renderApp, type Me } from "./helpers";
import type { MaterialDetailDto, MaterialDto, TagDto } from "../src/api/types";

const materialTags: TagDto[] = [
  { id: 1, name: "复盘", domain: "material", scope: "other", sort: 1, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
  { id: 2, name: "话术", domain: "material", scope: "other", sort: 2, enabled: true, createdAt: 1, updatedAt: 1, createdBy: null, updatedBy: null },
];

const m1: MaterialDto = {
  id: 1,
  kind: "transcript",
  title: "开营录音文字稿",
  url: null,
  contentLength: 5000,
  excerpt: "各位好，欢迎来到开营仪式……",
  originalFilename: null,
  contentType: null,
  fileSize: null,
  isImage: false,
  deliveryId: 11,
  delivery: {
    id: 11,
    name: null,
    deliveryType: { id: 5, name: "私董圈子", kind: "circle" },
    startsAt: 1700000000000,
    endsAt: null,
  },
  customers: [{ id: 101, nickname: "张三" }],
  tags: [{ id: 1, name: "复盘" }],
  createdAt: 1000,
  updatedAt: 2000,
  createdBy: null,
  updatedBy: null,
};

// 孤儿资料：无交付、无客户
const m2: MaterialDto = {
  id: 2,
  kind: "audio",
  title: "线下分享音频",
  url: "https://example.com/a.mp3",
  contentLength: 0,
  excerpt: null,
  originalFilename: null,
  contentType: null,
  fileSize: null,
  isImage: false,
  deliveryId: null,
  delivery: null,
  customers: [],
  tags: [],
  createdAt: 1000,
  updatedAt: 3000,
  createdBy: null,
  updatedBy: null,
};

const detail1: MaterialDetailDto = { ...m1, content: "各位好，欢迎来到开营仪式……（完整全文）" };

// 文件专区（kind=file）：f1 图片（渲染缩略图）、f2 PDF（图标占位）
const f1: MaterialDto = {
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
  deliveryId: null,
  delivery: null,
  customers: [],
  tags: [{ id: 1, name: "复盘" }],
  createdAt: 1000,
  updatedAt: 4000,
  createdBy: null,
  updatedBy: null,
};

const f2: MaterialDto = {
  id: 4,
  kind: "file",
  title: "复盘手册",
  url: null,
  contentLength: 0,
  excerpt: null,
  originalFilename: "手册.pdf",
  contentType: "application/pdf",
  fileSize: 3 * 1024 * 1024,
  isImage: false,
  deliveryId: 11,
  delivery: {
    id: 11,
    name: null,
    deliveryType: { id: 5, name: "私董圈子", kind: "circle" },
    startsAt: 1700000000000,
    endsAt: null,
  },
  customers: [],
  tags: [],
  createdAt: 1000,
  updatedAt: 5000,
  createdBy: null,
  updatedBy: null,
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

function mockMaterialsApi(me: Me, rows: MaterialDto[] = [m1, m2]) {
  const calls: Call[] = [];
  mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body });
    if (url === "/api/v1/auth/me") return { status: 200, body: { data: me } };
    // K58：资料域词表（列表筛选下拉 + 表单选词）
    if (url.startsWith("/api/v1/tags")) {
      return { status: 200, body: { data: materialTags, meta: { page: 1, pageSize: 100, total: materialTags.length } } };
    }
    // 交付单选项（MaterialFormModal 的 deliveryOptionsLoader）
    if (url.startsWith("/api/v1/deliveries")) {
      return {
        status: 200,
        body: {
          data: [
            {
              id: 11,
              deliveryType: { id: 5, name: "私董圈子", kind: "circle" },
              startsAt: 1700000000000,
              endsAt: null,
            },
          ],
          meta: { page: 1, pageSize: 100, total: 1 },
        },
      };
    }
    // 客户选项（MaterialFormModal 的 customerOptionsLoader）
    if (url.startsWith("/api/v1/customers")) {
      return {
        status: 200,
        body: { data: [{ id: 101, nickname: "张三" }], meta: { page: 1, pageSize: 100, total: 1 } },
      };
    }
    if (url === "/api/v1/materials/1" && method === "GET") {
      return { status: 200, body: { data: detail1 } };
    }
    // 创建成功后前端跳 /materials/99/edit → 编辑页拉详情
    if (url === "/api/v1/materials/99" && method === "GET") {
      return {
        status: 200,
        body: { data: { ...m2, id: 99, kind: "text", title: "复盘纪要", content: "", customers: [] } },
      };
    }
    if (url.startsWith("/api/v1/materials")) {
      if (method === "GET") {
        return { status: 200, body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } };
      }
      if (method === "POST") {
        if (url === "/api/v1/materials/upload") {
          const form = typeof FormData !== "undefined" && init?.body && typeof init.body === "object" && "get" in init.body
            ? (init.body as FormData)
            : null;
          return {
            status: 201,
            body: {
              data: {
                ...m2,
                id: 99,
                kind: "file",
                title: form?.get("title") ?? "对象",
                originalFilename: "a.png",
                contentType: "image/png",
                fileSize: 12,
                isImage: true,
              },
            },
          };
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { data: { ...m2, id: 99, ...body } } };
      }
      if (method === "PATCH") {
        const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { data: { ...detail1, ...patch, updatedAt: 2001 } } };
      }
      if (method === "DELETE") return { status: 204 };
    }
  });
  return calls;
}

describe("资料专区", () => {
  it("渲染列表：标题 + kind 徽章 + 关联交付/客户；孤儿资料显示「未关联」", async () => {
    mockMaterialsApi(adminMe);
    renderApp("/materials");

    expect(await screen.findByText("开营录音文字稿")).toBeTruthy();
    expect(screen.getAllByText("录音文字稿").length).toBeGreaterThan(0); // kind 徽章
    expect(screen.getByText(/私董圈子/)).toBeTruthy(); // 关联交付
    expect(screen.getByText("张三")).toBeTruthy(); // 关联客户 chip
    expect(screen.getByText("线下分享音频")).toBeTruthy();
    expect(screen.getAllByText("未关联").length).toBe(2); // 交付 + 客户
  });

  it("q 搜索 / kind 筛选 / 仅看未关联：请求参数正确", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "开营" } });
    await waitFor(
      () => {
        const hit = calls.find((c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?") && c.url.includes("q=%E5%BC%80%E8%90%A5"));
        expect(hit).toBeTruthy();
      },
      { timeout: 2000 },
    );

    fireEvent.change(screen.getByLabelText("类型筛选"), { target: { value: "audio" } });
    await waitFor(() => {
      const hit = calls.find((c) => c.url.includes("kind=audio"));
      expect(hit).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("仅看未关联"));
    await waitFor(() => {
      const hit = calls.find((c) => c.url.includes("orphan=1"));
      expect(hit).toBeTruthy();
    });
  });

  it("按关联交付类型分组 tab：默认「全部」不带 deliveryKind；点选后带对应 deliveryKind；回「全部」不带", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    // 五个 tab 齐全，默认「全部」选中
    for (const name of ["全部", "咨询类", "活动类", "圈子类", "其他"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    const allTab = screen.getByRole("tab", { name: "全部" });
    expect(allTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "圈子类" }));
    await waitFor(() => {
      const hit = calls.find((c) => c.url.includes("deliveryKind=circle"));
      expect(hit).toBeTruthy();
    });
    expect(screen.getByRole("tab", { name: "圈子类" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "其他" }));
    await waitFor(() => {
      const hit = calls.find((c) => c.url.includes("deliveryKind=other"));
      expect(hit).toBeTruthy();
    });

    // 回「全部」：最新 GET 不再带 deliveryKind
    fireEvent.click(screen.getByRole("tab", { name: "全部" }));
    await waitFor(() => {
      const gets = calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?"));
      const last = gets[gets.length - 1];
      expect(last).toBeTruthy();
      expect(last?.url).not.toContain("deliveryKind");
    });
  });

  it("新增资料：kind 切换 content/url 显隐；文本类 POST content、媒体类 POST url", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "新增资料" }));
    const dialog = screen.getByRole("dialog", { name: "新增资料" });

    // 默认文本类：内容（可选初稿）可见、链接不可见
    expect(within(dialog).getByLabelText(/内容/)).toBeTruthy();
    expect(within(dialog).queryByLabelText(/链接/)).toBeNull();

    // 填文本类字段 + 关联交付/客户（EntityPicker：搜索 → 点候选）
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: "复盘纪要" } });
    fireEvent.change(within(dialog).getByLabelText(/内容/), { target: { value: "本周复盘正文" } });
    fireEvent.change(within(dialog).getByLabelText("关联交付单"), { target: { value: "私董" } });
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: /私董圈子 #11/ }));
    fireEvent.change(within(dialog).getByLabelText("搜索客户"), { target: { value: "张" } });
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: "张三" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/materials");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        kind: "text",
        title: "复盘纪要",
        content: "本周复盘正文",
        url: null,
        deliveryId: 11,
        customerIds: [101],
      });
    });

    // 创建成功后自动跳全文编辑页（GET /materials/99 → 编辑器渲染）
    expect(await screen.findByLabelText("正文内容")).toBeTruthy();
  });

  it("新增媒体类资料：切到音频 → 内容消失、链接出现并必填；创建成功跳编辑页（无正文提示）", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "新增资料" }));
    const dialog = screen.getByRole("dialog", { name: "新增资料" });
    fireEvent.change(within(dialog).getByLabelText(/资料类型/), { target: { value: "audio" } });
    expect(within(dialog).queryByLabelText(/内容/)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: "播客" } });
    fireEvent.change(within(dialog).getByLabelText(/链接/), { target: { value: "https://example.com/p.mp3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/v1/materials");
      const body = JSON.parse(String(posts[0]?.body)) as Record<string, unknown>;
      expect(body.kind).toBe("audio");
      expect(body.url).toBe("https://example.com/p.mp3");
      expect(body.content).toBeNull();
    });
  });

  it("文本类内容可空：不填内容也可创建（全文后补）", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "新增资料" }));
    const dialog = screen.getByRole("dialog", { name: "新增资料" });
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: "占位资料" } });
    // 不填内容直接创建
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/materials");
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body.content).toBe("");
      expect(body.title).toBe("占位资料");
    });
  });

  it("修改资料：先 GET 详情再编辑 → PATCH 带 updatedAt（OCC）", async () => {
    const calls = mockMaterialsApi(adminMe, [m1]);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const dialog = await screen.findByRole("dialog", { name: /修改资料/ });
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/v1/materials/1")).toBe(true);
    // 预填全文 content
    expect((within(dialog).getByLabelText(/内容/) as HTMLTextAreaElement).value).toContain("完整全文");

    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: "开营录音文字稿（修订）" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/materials/1");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body)) as Record<string, unknown>;
      expect(body.updatedAt).toBe(2000);
      expect(body.title).toBe("开营录音文字稿（修订）");
    });
  });

  it("查看资料：GET 详情后只读展示完整 content", async () => {
    const calls = mockMaterialsApi(adminMe, [m1]);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    const dialog = await screen.findByRole("dialog", { name: "开营录音文字稿" });
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/v1/materials/1")).toBe(true);
    expect(within(dialog).getByText(/完整全文/)).toBeTruthy();
    expect(within(dialog).getByText("张三")).toBeTruthy();
    // 只读：无保存按钮
    expect(within(dialog).queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("删除资料：ConfirmDialog 确认后 DELETE，列表刷新", async () => {
    const calls = mockMaterialsApi(adminMe, [m1]);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "删除资料" });
    expect(within(dialog).getByText(/开营录音文字稿/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/materials/1")).toBe(true);
    });
    // 删除后重新拉列表
    await waitFor(() => {
      const gets = calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?"));
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("K58 标签列渲染 + 标签筛选下拉：选词后列表请求带 tagId", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    // 标签列：m1 的「复盘」徽章（资料域词表下拉同时加载，下拉里也有同名 option）
    expect(screen.getAllByText("复盘").length).toBeGreaterThan(0);
    const select = screen.getByLabelText("标签筛选") as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "话术" })).toBeTruthy());

    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => {
      const hit = calls.find(
        (c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?") && c.url.includes("tagId=2"),
      );
      expect(hit).toBeTruthy();
    });
  });

  it("K58 新增资料：词表选词 + 回车添加新词 + 同名回车复用 → POST 带 tagIds/newTagNames", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "新增资料" }));
    const dialog = screen.getByRole("dialog", { name: "新增资料" });
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: "带标签资料" } });

    const tagInput = within(dialog).getByLabelText("搜索资料标签");
    // 聚焦展开候选，点候选选词表词「话术」
    fireEvent.focus(tagInput);
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: "话术" }));
    // 回车添加新词（前后空白被 trim）
    fireEvent.change(tagInput, { target: { value: "  新主题  " } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    // 回车输入词表已有词 = 复用进 tagIds，不进 newTagNames
    fireEvent.change(tagInput, { target: { value: "复盘" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/materials");
      expect(post).toBeTruthy();
      const body = JSON.parse(String(post?.body)) as Record<string, unknown>;
      expect(body.tagIds).toEqual([2, 1]);
      expect(body.newTagNames).toEqual(["新主题"]);
    });
  });

  it("K58 修改资料：移除已有标签 → PATCH tagIds: [] + newTagNames: []（清空语义）", async () => {
    const calls = mockMaterialsApi(adminMe, [m1]);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    const dialog = await screen.findByRole("dialog", { name: /修改资料/ });
    // 编辑模式用 material.tags 预填 chip
    fireEvent.click(within(dialog).getByRole("button", { name: "移除 复盘" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH" && c.url === "/api/v1/materials/1");
      expect(patch).toBeTruthy();
      const body = JSON.parse(String(patch?.body)) as Record<string, unknown>;
      expect(body.tagIds).toEqual([]);
      expect(body.newTagNames).toEqual([]);
    });
  });

  it("新增对象存储资料：切到对象存储 → 文件输入出现；FormData 上传（含标签键）不跳编辑页", async () => {
    const calls = mockMaterialsApi(adminMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");

    fireEvent.click(screen.getByRole("button", { name: "新增资料" }));
    const dialog = screen.getByRole("dialog", { name: "新增资料" });
    fireEvent.change(within(dialog).getByLabelText(/资料类型/), { target: { value: "file" } });
    expect(within(dialog).queryByLabelText(/链接/)).toBeNull();
    expect(within(dialog).getByLabelText(/文件/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText(/标题/), { target: { value: "现场照片" } });
    // K58：选一个词表标签，验证 multipart 以 JSON 数组字符串携带
    const tagInput = within(dialog).getByLabelText("搜索资料标签");
    fireEvent.focus(tagInput);
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: "话术" }));
    const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    fireEvent.change(within(dialog).getByLabelText(/文件/), { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url === "/api/v1/materials/upload");
      expect(post).toBeTruthy();
      const form = post?.body as unknown as FormData;
      expect(form.get("tagIds")).toBe("[2]");
      expect(form.get("newTagNames")).toBe("[]");
    });
    expect(screen.queryByLabelText("正文内容")).toBeNull();
  });

  it("assistant 只读：无新增/修改/删除，仅查看", async () => {
    mockMaterialsApi(assistantMe);
    renderApp("/materials");
    await screen.findByText("开营录音文字稿");
    expect(screen.queryByRole("button", { name: "新增资料" })).toBeNull();
    expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "查看" }).length).toBe(2);
  });
});

describe("资料专区 · 文件专区 tab", () => {
  it("切到文件专区：请求带 kind=file；图片卡片渲染缩略图，非图片给图标占位 + 文件名·大小 + 下载链接", async () => {
    const calls = mockMaterialsApi(adminMe, [f1, f2]);
    renderApp("/materials");

    fireEvent.click(await screen.findByRole("tab", { name: "文件专区" }));
    await waitFor(() => {
      const hit = calls.find(
        (c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?") && c.url.includes("kind=file"),
      );
      expect(hit).toBeTruthy();
    });

    // 图片卡片：缩略图直出 /materials/:id/file
    const img = await screen.findByAltText("合影.png");
    expect(img.getAttribute("src")).toBe("/api/v1/materials/3/file");
    // 非图片卡片：扩展名占位 + 文件名·大小
    expect(screen.getByText("pdf")).toBeTruthy();
    expect(screen.getByText(/手册\.pdf · 3\.0 MB/)).toBeTruthy();
    // 两张卡片都有下载链接（download=1）
    const downloads = screen.getAllByRole("link", { name: "下载" });
    expect(downloads.map((a) => a.getAttribute("href"))).toEqual([
      "/api/v1/materials/3/file?download=1",
      "/api/v1/materials/4/file?download=1",
    ]);
    // 标签徽章 + 标题
    expect(screen.getByText("复盘")).toBeTruthy();
    expect(screen.getByText("复盘手册")).toBeTruthy();
  });

  it("文件专区搜索：q 与 kind=file 一起发出", async () => {
    const calls = mockMaterialsApi(adminMe, [f1]);
    renderApp("/materials");
    fireEvent.click(await screen.findByRole("tab", { name: "文件专区" }));
    await screen.findByAltText("合影.png");

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "合影" } });
    await waitFor(
      () => {
        const hit = calls.find((c) => c.url.includes("kind=file") && c.url.includes("q=%E5%90%88%E5%BD%B1"));
        expect(hit).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });

  it("assistant 文件专区：仅查看/下载，无修改/删除", async () => {
    mockMaterialsApi(assistantMe, [f1, f2]);
    renderApp("/materials");
    fireEvent.click(await screen.findByRole("tab", { name: "文件专区" }));
    await screen.findByAltText("合影.png");

    expect(screen.getAllByRole("button", { name: "查看" }).length).toBe(2);
    expect(screen.getAllByRole("link", { name: "下载" }).length).toBe(2);
    expect(screen.queryByRole("button", { name: "修改" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });

  it("按交付名定位交付并过滤：选中交付单后请求带 deliveryId，移除 chip 后不再带", async () => {
    const calls = mockMaterialsApi(adminMe, [f2]);
    renderApp("/materials");
    fireEvent.click(await screen.findByRole("tab", { name: "文件专区" }));
    await screen.findByText("复盘手册");

    const input = screen.getByLabelText("按交付过滤");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "私董" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /私董圈子 #11/ }));
    await waitFor(() => {
      const hit = calls.find(
        (c) =>
          c.method === "GET" &&
          c.url.startsWith("/api/v1/materials?") &&
          c.url.includes("kind=file") &&
          c.url.includes("deliveryId=11"),
      );
      expect(hit).toBeTruthy();
    });

    // chip × 移除 → 最新请求不再带 deliveryId
    fireEvent.click(screen.getByRole("button", { name: /移除 私董圈子/ }));
    await waitFor(() => {
      const gets = calls.filter(
        (c) => c.method === "GET" && c.url.startsWith("/api/v1/materials?") && c.url.includes("kind=file"),
      );
      const last = gets[gets.length - 1];
      expect(last).toBeTruthy();
      expect(last?.url).not.toContain("deliveryId");
    });
  });
});
