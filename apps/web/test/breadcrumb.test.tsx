import { describe, expect, it } from "vitest";

import { breadcrumbLabel } from "../src/layout/breadcrumb";

describe("面包屑（breadcrumbLabel）", () => {
  it("非四张主表页面也返回模块名（由 PAGE_REGISTRY 推导）", () => {
    expect(breadcrumbLabel("/materials")).toBe("资料专区");
    expect(breadcrumbLabel("/deals")).toBe("成交记录");
    expect(breadcrumbLabel("/deliveries")).toBe("交付管理");
    expect(breadcrumbLabel("/delivery-types")).toBe("交付类型");
    expect(breadcrumbLabel("/settings")).toBe("系统设置");
    expect(breadcrumbLabel("/business-settings")).toBe("客户标签词表");
    expect(breadcrumbLabel("/my/customers")).toBe("我的客户");
  });

  it("详情页沿 parent 返回菜单模块名", () => {
    expect(breadcrumbLabel("/customers/1")).toBe("客户信息");
    expect(breadcrumbLabel("/deliveries/1")).toBe("交付管理");
    expect(breadcrumbLabel("/deliveries/1/circle")).toBe("交付管理");
    expect(breadcrumbLabel("/deliveries/1/gantt")).toBe("交付管理");
    expect(breadcrumbLabel("/deliveries/1/matrix")).toBe("交付管理");
  });

  it("未知路径返回空字符串", () => {
    expect(breadcrumbLabel("/nope")).toBe("");
    expect(breadcrumbLabel("/")).toBe("");
  });
});
