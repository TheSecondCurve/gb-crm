// 面包屑工具：把 pathname 映射到「最深菜单祖先页」标签（design.md 惯例）。
// 详情型路由（/customers/:id、/deliveries/:id/circle）沿 parent 找到菜单页，
// 使顶栏永远显示当前所在模块，而不是空字符串。纯函数便于单测。
import { PAGE_REGISTRY, PAGE_REGISTRY_BY_KEY, type PageDef, type PageKey } from "@gb-crm/shared";

export function breadcrumbLabel(pathname: string): string {
  for (const def of PAGE_REGISTRY) {
    const re = new RegExp("^" + def.path.replace(/:[^/]+/g, "[^/]+") + "$");
    if (!re.test(pathname)) continue;
    let cur: PageDef | undefined = def;
    while (cur && !cur.menu) cur = cur.parent ? PAGE_REGISTRY_BY_KEY[cur.parent as PageKey] : undefined;
    return cur?.label ?? def.label;
  }
  return "";
}
