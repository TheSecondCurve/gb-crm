// requireCan(resource, action) preHandler 工厂（§6 / K18）：
// 权限策略唯一来源是 packages/shared 的 can() 矩阵，路由只挂 preHandler，
// 不在 service 里复制细项。request.user 为空 → 401；can() = false → 403 FORBIDDEN。
import { can, type Action, type Resource } from "@gb-crm/shared";
import type { preHandlerHookHandler } from "fastify";

import { forbidden, unauthorized } from "./error-handler.js";

export function requireCan(resource: Resource, action: Action): preHandlerHookHandler {
  return async (req) => {
    const user = req.user; // session-auth 装饰；未登录已被拦 401，这里兜底
    if (user === null) throw unauthorized();
    if (!can(user.systemRole, resource, action)) throw forbidden();
  };
}
