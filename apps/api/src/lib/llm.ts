// OpenAI 兼容 /chat/completions 最小客户端（K46，零新增依赖：Node 24 原生 fetch）。
// 只支持 OpenAI 协议：POST {baseUrl}/chat/completions，Bearer apiKey。
// 不强制 response_format（部分「OpenAI 兼容」供应商不支持未知字段会报错），
// 由 prompt 内联约束输出 JSON + 宽松解析兜底。
export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatJsonOptions {
  settings: LlmSettings;
  messages: LlmMessage[];
  /** 默认 30s（AbortSignal.timeout） */
  timeoutMs?: number;
  /** 测试注入 mock；默认全局 fetch */
  fetchFn?: typeof fetch;
  temperature?: number;
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/** 调 /chat/completions 并把 choices[0].message.content 宽松解析为 JSON 对象 */
export async function chatJson<T = Record<string, unknown>>(opts: ChatJsonOptions): Promise<T> {
  const {
    settings,
    messages,
    timeoutMs = 30_000,
    fetchFn = fetch,
    temperature = 0,
  } = opts;
  const base = settings.baseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({ model: settings.model, messages, temperature }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(`调用 LLM 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LlmError(`LLM 服务返回 ${res.status}：${body.slice(0, 200)}`);
  }

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new LlmError("LLM 返回内容为空");
  return parseLooseJson(content) as T;
}

/** 剥代码围栏/前后杂文，取首个 { … } 解析；失败抛 LlmError */
export function parseLooseJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new LlmError("LLM 返回内容无法解析为 JSON");
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(first, last + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new LlmError("LLM 返回 JSON 不是对象");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError("LLM 返回内容无法解析为 JSON");
  }
}
