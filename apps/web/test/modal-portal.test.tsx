import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Modal } from "../src/components/Modal";

// 弹层定位回归（K66 修）：Modal 必须 portal 到 document.body。
// 此前 .modal-mask 内联在页面树里，任何祖先带 transform（如 .main 的 page-enter
// 动画 fill-mode 残留）都会把 position: fixed 劫持为相对整页内容定位——
// 长表格页（设置/后台任务）点「详情」弹窗会落到滚动深处。
describe("Modal 弹层挂载", () => {
  it("弹窗通过 portal 渲染到 document.body，不留在组件容器内", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      <Modal title="任务详情" onClose={() => {}}>
        <p>内容</p>
      </Modal>,
      { container },
    );

    const mask = screen.getByRole("dialog", { name: "任务详情" }).parentElement;
    expect(mask).toBeTruthy();
    expect(mask!.classList.contains("modal-mask")).toBe(true);
    // 不在组件容器内 → fixed 相对视口定位不被页面内 transform 劫持
    expect(container.contains(mask!)).toBe(false);
    expect(mask!.parentElement).toBe(document.body);

    container.remove();
  });
});
