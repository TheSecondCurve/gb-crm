/** 同源 fetch 封装（/api/v1，camelCase）。错误一律抛 ApiError，message 为服务端中文文案，可直接 Toast。 */

const API_BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** CONFLICT（409）时服务端带上的当前行 */
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 会话失效回调（H4）：任意请求收到 401 时触发（登录接口自身除外），由 AuthProvider 注册 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // H4：会话失效分流——401 时通知 AuthProvider 清空 me（登录接口自身的 401 是正常失败，排除）
    if (
      res.status === 401 &&
      !(method === "POST" && path === "/auth/login") &&
      unauthorizedHandler
    ) {
      unauthorizedHandler();
    }
    const err = (json as { error?: { code?: string; message?: string }; data?: unknown } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? "请求失败，请稍后重试",
      (json as { data?: unknown } | null)?.data,
    );
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/** camelCase query 构造（K21）。null / undefined / 空串跳过。 */
export function buildQuery(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
