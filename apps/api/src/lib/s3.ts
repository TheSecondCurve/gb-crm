// S3 兼容对象存储最小客户端（K53，零新增依赖：node:crypto + 原生 fetch）。
// SigV4 签名（AWS Signature Version 4）+ path-style 寻址（endpoint[/base]/bucket/key），
// 兼容 AWS S3 / MinIO / 阿里云 OSS / 腾讯云 COS / Cloudflare R2 等。
// 只实现备份所需的最小面：PutObject / DeleteObject / 连通性探针。
import { createHash, createHmac } from "node:crypto";

export interface S3ClientConfig {
  endpoint: string;
  /** 空 → us-east-1 */
  region: string | null;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3Error";
  }
}

export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const sha256Hex = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

/** AWS uriEscape：encodeURIComponent 后补编 !'()*（unreserved 之外全编码；/ 由调用方拆段保留） */
function awsUriEscape(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** path-style 规范化路径：/bucket/key（key 按段编码，bucket 字符集已在配置层限定） */
export function encodeS3KeyPath(bucket: string, key: string): string {
  return `/${awsUriEscape(bucket)}/${key.split("/").map(awsUriEscape).join("/")}`;
}

export interface SigV4Input {
  method: string;
  /** Host 头值（含非默认端口） */
  host: string;
  /** 已编码、以 / 开头的规范化路径 */
  path: string;
  /** 已编码 query（不含 ?），默认空 */
  query?: string;
  /** 参与签名的额外头（如 Range）；生产路径不用 */
  extraHeaders?: Record<string, string>;
  payloadHash: string;
  /** yyyyMMdd'T'HHmmss'Z' */
  amzDate: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string | null;
  service?: string;
}

export interface SigV4Result {
  canonicalRequest: string;
  stringToSign: string;
  authorization: string;
}

/** SigV4 签名核心（独立导出：单测对拍 AWS 官方已知答案向量） */
export function signS3Request(input: SigV4Input): SigV4Result {
  const region = input.region || "us-east-1";
  const service = input.service ?? "s3";
  const dateStamp = input.amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host: input.host.trim(),
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": input.amzDate,
  };
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    headers[name.toLowerCase()] = value.trim();
  }
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join(
    "\n",
  );

  let key = createHmac("sha256", `AWS4${input.secretAccessKey}`).update(dateStamp).digest();
  key = createHmac("sha256", key).update(region).digest();
  key = createHmac("sha256", key).update(service).digest();
  key = createHmac("sha256", key).update("aws4_request").digest();
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},` +
    `SignedHeaders=${signedHeaders},Signature=${signature}`;

  return { canonicalRequest, stringToSign, authorization };
}

interface S3RequestOptions {
  /** 测试注入 mock；默认全局 fetch */
  fetchFn?: typeof fetch;
  /** 默认 PUT 60s / 探针 DELETE 10s（AbortSignal.timeout） */
  timeoutMs?: number;
}

type S3PutOptions = S3RequestOptions & { contentType?: string };

function amzDateNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

async function s3Request(
  cfg: S3ClientConfig,
  method: "PUT" | "DELETE",
  key: string,
  body: Buffer | undefined,
  opts: S3RequestOptions & { contentType?: string },
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  // endpoint 允许带 base path（如网关型部署）：/base/bucket/key
  let url: URL;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new S3Error("Endpoint 不是合法的 http(s) 地址");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${encodeS3KeyPath(cfg.bucket, key)}`;

  const payloadHash = body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256;
  const amzDate = amzDateNow();
  const { authorization } = signS3Request({
    method,
    host: url.host,
    path: encodeS3KeyPath(cfg.bucket, key),
    payloadHash,
    amzDate,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
  });

  let res: Response;
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        "Content-Type": opts.contentType ?? "application/octet-stream",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new S3Error(`连接对象存储失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new S3Error(`对象存储返回 ${res.status}：${(text || res.statusText).slice(0, 200)}`);
  }
}

export async function s3PutObject(
  cfg: S3ClientConfig,
  key: string,
  body: Buffer,
  opts: S3PutOptions = {},
): Promise<void> {
  await s3Request(cfg, "PUT", key, body, opts);
}

export async function s3DeleteObject(
  cfg: S3ClientConfig,
  key: string,
  opts: S3RequestOptions = {},
): Promise<void> {
  await s3Request(cfg, "DELETE", key, undefined, opts);
}

/**
 * 连通性探测：写一个固定探针对象再尽力删除。备份只依赖 PutObject 权限，
 * 删除失败不视为配置问题（返回的 key 固定，可人工清理）。返回实际使用的探针 key。
 */
export async function s3Probe(
  cfg: S3ClientConfig,
  prefix = "",
  opts: S3RequestOptions = {},
): Promise<string> {
  const probeKey = `${prefix}.gb-crm-probe.txt`;
  await s3PutObject(cfg, probeKey, Buffer.from("gb-crm connectivity probe"), {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 10_000,
    contentType: "text/plain",
  });
  try {
    await s3DeleteObject(cfg, probeKey, { fetchFn: opts.fetchFn, timeoutMs: 10_000 });
  } catch {
    // 尽力而为
  }
  return probeKey;
}
