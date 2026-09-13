// K61 /api/v1/workbench 路由 + /agent/workbench/install.sh 安装器下发。
// 权限模型（对齐 agent/sql 的 PAT 语义，不走 requireCan / 无新 ACL 资源）：
// - 发布 POST：仅 admin（cookie 管理端或 write PAT；read PAT 已被 session-auth 按
//   「read 令牌仅 GET/HEAD」拦下，operator 一律 403）——发布是质量门，只属于维护者。
// - 读取 GET（版本列表 / manifest / 对象下载）：任意已认证身份（read PAT 即可），
//   团队成员人手一个 read 令牌就能同步。
// - /agent/workbench/install.sh：公开（无密钥，同 /agent/login.sh 信任面）。
import { pageQuerySchema } from "@gb-crm/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { forbidden, notFound, unprocessable } from "../../plugins/error-handler.js";
import { publicBaseUrl } from "../auth/login-script.js";
import { renderWorkbenchInstallScript } from "./install-script.js";
import {
  getWorkbenchObject,
  latestWorkbenchVersionResult,
  listWorkbenchVersionsResult,
  manifestTsvTarget,
  publishWorkbenchVersion,
  renderManifestTsv,
  workbenchVersionResult,
} from "./service.js";

export interface WorkbenchRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
  /** S3 fetch 注入（测试 mock）；默认全局 fetch */
  s3Fetch?: typeof fetch;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const shaParamSchema = z.object({ sha: z.string().min(1).max(128) });
const manifestQuerySchema = z.object({
  /** 回滚 / 校验用：显式取某版本清单；缺省最新 */
  version: z.coerce.number().int().positive().optional(),
});
const publishFieldsSchema = z.object({
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/i, "commitSha 必须是 7~40 位十六进制"),
  subject: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});

/** multipart 读取：单文件字段 bundle + 若干文本字段（同 materials 上传模式） */
async function readPublishMultipart(
  req: FastifyRequest,
): Promise<{ bundle: Buffer; fields: Record<string, string> }> {
  if (!req.isMultipart()) {
    throw unprocessable("请使用 multipart/form-data 上传发布包（bundle=tar.gz）");
  }
  const fields: Record<string, string> = {};
  let bundle: Buffer | null = null;
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (bundle) throw unprocessable("一次只能上传一个发布包文件");
      bundle = await part.toBuffer();
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  if (!bundle) throw unprocessable("请选择要上传的 tar.gz 发布包（字段名 bundle）");
  return { bundle, fields };
}

export function workbenchRoutes(app: FastifyInstance, opts: WorkbenchRoutesOptions): void {
  const { db, now, s3Fetch } = opts;

  // 发布新版本（write PAT 或 cookie，admin only）
  app.post("/api/v1/workbench/versions", async (req) => {
    if (req.user?.systemRole !== "admin") {
      throw forbidden("仅管理员可发布工作台快照");
    }
    const { bundle, fields } = await readPublishMultipart(req);
    const parsed = publishFieldsSchema.parse(fields);
    const result = await publishWorkbenchVersion(db, {
      bundle,
      commitSha: parsed.commitSha.toLowerCase(),
      commitSubject: parsed.subject ?? null,
      note: parsed.note ?? null,
      publishedBy: req.user.id,
      now: now(),
      fetchFn: s3Fetch,
    });
    return { data: result };
  });

  // 版本列表（分页）
  app.get("/api/v1/workbench/versions", async (req) => {
    const q = pageQuerySchema.parse(req.query ?? {});
    return listWorkbenchVersionsResult(db, q);
  });

  // 最新版本详情（含 manifest）
  app.get("/api/v1/workbench/versions/latest", async () => {
    const dto = latestWorkbenchVersionResult(db);
    if (!dto) throw notFound("尚未发布任何工作台版本");
    return { data: dto };
  });

  // 指定版本详情（含 manifest；回滚核对用）
  app.get("/api/v1/workbench/versions/:id", async (req) => {
    const { id } = idParamSchema.parse(req.params);
    const dto = workbenchVersionResult(db, id);
    if (!dto) throw notFound("版本不存在");
    return { data: dto };
  });

  // 脚本友好的 manifest（TSV）：`#key\tvalue` 元数据 + `sha\tsize\tmode\tpath` 数据行
  app.get("/api/v1/workbench/manifest.tsv", async (req, reply) => {
    const q = manifestQuerySchema.parse(req.query ?? {});
    const row = manifestTsvTarget(db, q.version ?? null);
    return reply.header("Content-Type", "text/plain; charset=utf-8").send(renderManifestTsv(row));
  });

  // 对象下载（CRM 代理 S3，成员机只要求可达 CRM；内容寻址不可变，ETag 即 sha256）
  app.get("/api/v1/workbench/objects/:sha", async (req, reply) => {
    const { sha } = shaParamSchema.parse(req.params);
    const normalized = sha.toLowerCase();
    const body = await getWorkbenchObject(db, normalized, { fetchFn: s3Fetch });
    if (!body) throw notFound("对象不存在");
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", body.length)
      .header("ETag", `"${normalized}"`)
      .send(body);
  });

  // ── 安装器下发（K61 渠道；内网可用、无需 GitHub；/agent/* 不走 session-auth）──
  app.get("/agent/workbench/install.sh", async (req, reply) => {
    const script = renderWorkbenchInstallScript(publicBaseUrl(req));
    return reply
      .header("Content-Type", "text/x-shellscript; charset=utf-8")
      .header("Content-Disposition", 'inline; filename="install.sh"')
      .send(script);
  });
}
