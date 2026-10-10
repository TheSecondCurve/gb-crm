// K63 素材图片 AI 识别（vision LLM 异步识别管线）。
// 调度：上传/替换图片后 scheduleMaterialEnrich——aiEnrich≠false 且是可预览图片时：
//   超过 MATERIAL_AI_ENRICH_MAX_BYTES → ai_status=skipped（base64 体积膨胀，不送模型）；
//   LLM 未配置（assetsLlm 不完整且系统 llm 不完整）→ ai_status=skipped（静默，不影响上传）；
//   否则 ai_status=pending + 入队 material-ai-enrich 任务（K51 串行消费）。
// 执行 enrichMaterial：S3 拉对象 → base64 vision 请求 → 结构化 JSON → 落库规则：
//   description 只填空（人/agent 写过的不动）；标签并集合并（newTagNames 通道免审批建词，全量 ≤8）；
//   folder 只从现有 live 文件夹完整路径里精确匹配（AI 不能凭空建目录）；ready + enriched_at。
// 失败 → ai_status=failed（可 POST /materials/:id/enrich 重跑）；S3/LLM 未配置 → skipped。
import { MATERIAL_AI_ENRICH_MAX_BYTES } from "@gb-crm/shared";
import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { backgroundJobs, deliveryMaterials } from "../../db/schema.js";
import { chatJson, imagePart, type LlmSettings } from "../../lib/llm.js";
import { s3GetObject, type S3ClientConfig } from "../../lib/s3.js";
import { notFound, unprocessable } from "../../plugins/error-handler.js";
import { listEnabledLiveTags } from "../tags/repo.js";
import { getAiConfig, getAssetsLlmConfig, getMaterialsS3Config, isLlmConfigReady, isS3RemoteReady } from "../system/repo.js";
import { applyMaterialTags, existingMaterialTagIds } from "./tag-attach.js";
import { folderPathIndex, pathOfFolder } from "./folder-service.js";
import { isPreviewableImage } from "./file-meta.js";
import { getMaterialByIdAny, type MaterialRow } from "./repo.js";

/** LLM 通道选取：assetsLlm 完整优先（需 vision 模型），否则回退系统 code='llm'；都不行 → null */
export function resolveAssetsLlmSettings(db: Db): LlmSettings | null {
  const dedicated = getAssetsLlmConfig(db);
  if (isLlmConfigReady(dedicated)) {
    return { baseUrl: dedicated.baseUrl, apiKey: dedicated.apiKey, model: dedicated.model };
  }
  const systemCfg = getAiConfig(db);
  if (isLlmConfigReady(systemCfg)) {
    return { baseUrl: systemCfg.baseUrl, apiKey: systemCfg.apiKey, model: systemCfg.model };
  }
  return null;
}

/** 任何 LLM 通道是否可用（job 创建预检用） */
export function isAssetsLlmReady(db: Db): boolean {
  return resolveAssetsLlmSettings(db) !== null;
}

function setAiStatus(
  db: Db,
  id: number,
  status: "pending" | "ready" | "failed" | "skipped" | null,
  audit: { now: number; userId: number | null },
  enriched = false,
): void {
  db.update(deliveryMaterials)
    .set({
      aiStatus: status,
      ...(enriched ? { enrichedAt: audit.now } : {}),
      updatedAt: audit.now,
      updatedBy: audit.userId,
    })
    .where(eq(deliveryMaterials.id, id))
    .run();
}

/** 上传/替换后调度：判定 + 置状态 + 入队（事务外调用；非图片/显式关闭不动 ai_status） */
export function scheduleMaterialEnrich(
  db: Db,
  row: MaterialRow,
  opts: { aiEnrich?: boolean; now: number; userId: number | null },
): void {
  if (opts.aiEnrich === false) return;
  if (row.kind !== "file") return;
  const isImage = isPreviewableImage(row.contentType, row.originalFilename);
  if (!isImage) {
    // 非图片（如替换成了 PDF）：清掉旧识别痕迹
    if (row.aiStatus !== null) setAiStatus(db, row.id, null, opts);
    return;
  }
  if (row.fileSize === null || row.fileSize > MATERIAL_AI_ENRICH_MAX_BYTES) {
    setAiStatus(db, row.id, "skipped", opts);
    return;
  }
  if (!isAssetsLlmReady(db)) {
    setAiStatus(db, row.id, "skipped", opts);
    return;
  }
  setAiStatus(db, row.id, "pending", opts);
  db.insert(backgroundJobs)
    .values({
      type: "material-ai-enrich",
      params: JSON.stringify({ materialId: row.id }),
      status: "queued",
      progress: JSON.stringify({ processed: 0, total: 1, succeeded: 0, failed: 0 }),
      trigger: "manual",
      createdAt: opts.now,
      createdBy: opts.userId,
    })
    .run();
}

/** 手动重跑端点：显式请求 → 配置缺失报 422（区别于上传时的静默 skip） */
export function requestMaterialEnrich(
  db: Db,
  id: number,
  audit: { now: number; userId: number | null },
): { id: number; aiStatus: "pending" } {
  const row = getMaterialByIdAny(db, id);
  if (!row || row.deletedAt !== null) throw notFound("资料不存在");
  if (row.kind !== "file" || !isPreviewableImage(row.contentType, row.originalFilename)) {
    throw unprocessable("只有可预览图片（jpeg/png/gif/webp/bmp）支持 AI 识别");
  }
  if (row.fileSize !== null && row.fileSize > MATERIAL_AI_ENRICH_MAX_BYTES) {
    throw unprocessable(`图片超过 ${MATERIAL_AI_ENRICH_MAX_BYTES >> 20}MB，不送 AI 识别`);
  }
  if (!isAssetsLlmReady(db)) {
    throw unprocessable("请先在「系统设置」配置素材识别 LLM（或系统 LLM）");
  }
  setAiStatus(db, id, "pending", audit);
  db.insert(backgroundJobs)
    .values({
      type: "material-ai-enrich",
      params: JSON.stringify({ materialId: id }),
      status: "queued",
      progress: JSON.stringify({ processed: 0, total: 1, succeeded: 0, failed: 0 }),
      trigger: "manual",
      createdAt: audit.now,
      createdBy: audit.userId,
    })
    .run();
  return { id, aiStatus: "pending" };
}

// ---- 执行 ----

interface EnrichOutput {
  description?: string;
  tags?: string[];
  folder?: string | null;
}

/** prompt 注入的候选上限（文件夹/标签词表都是小量级，防御性截断） */
const MAX_FOLDER_CANDIDATES = 50;
const MAX_TAG_CANDIDATES = 100;
/** LLM 建议标签总数上限（含复用现有词；newTagNames 通道本身 ≤10） */
const MAX_TAGS_APPLY = 8;

const ENRICH_SYSTEM_PROMPT = `你是素材库的图片识别助手。看图后只输出一个 JSON 对象，不要输出任何其他文字：
{"description": "…", "tags": ["…"], "folder": "…" 或 null}
规则：
- description：30~80 字中文，客观描述画面（主体、场景、颜色、可见文字、风格），信息密度高，便于日后搜索。
- tags：3~8 个简短检索词（2~6 字优先）。优先从「候选标签」里选用；确有必要可以新增，最多新增 3 个。
- folder：从「候选文件夹」里选一个最贴切的完整路径原样输出；都不贴切输出 null，禁止自己编造路径。`;

function buildUserPrompt(db: Db, row: MaterialRow): string {
  const index = folderPathIndex(db);
  const folders = Array.from(index.values())
    .map((f) => pathOfFolder(f, index))
    .sort()
    .slice(0, MAX_FOLDER_CANDIDATES);
  const tagNames = listEnabledLiveTags(db, "material")
    .map((t) => t.name)
    .sort()
    .slice(0, MAX_TAG_CANDIDATES);
  const dims =
    row.imageWidth !== null && row.imageHeight !== null
      ? `${row.imageWidth}×${row.imageHeight} 像素`
      : "尺寸未知";
  const sizeKb = row.fileSize !== null ? Math.max(1, Math.round(row.fileSize / 1024)) : null;
  return [
    `标题：${row.title}`,
    `原始文件名：${row.originalFilename ?? "未知"}`,
    `格式：${row.contentType ?? "未知"}，${dims}${sizeKb !== null ? `，约 ${sizeKb}KB` : ""}`,
    `候选标签：${JSON.stringify(tagNames)}`,
    `候选文件夹：${JSON.stringify(folders)}`,
  ].join("\n");
}

/** LLM 结果落库：description 只填空；标签并集；folder 只匹配现有完整路径 */
function applyEnrichResult(
  db: Db,
  row: MaterialRow,
  out: EnrichOutput,
  audit: { now: number; userId: number | null },
): void {
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    const patch: Record<string, unknown> = {};
    // description 只填空（人/agent 写过的不覆盖）
    if (!row.description && typeof out.description === "string" && out.description.trim() !== "") {
      patch.description = out.description.trim().slice(0, 2000);
    }
    // folder 只从现有 live 文件夹完整路径精确匹配
    if (typeof out.folder === "string" && out.folder.trim() !== "" && row.folderId === null) {
      const index = folderPathIndex(t);
      for (const f of index.values()) {
        if (pathOfFolder(f, index) === out.folder.trim()) {
          patch.folderId = f.id;
          break;
        }
      }
    }
    if (Object.keys(patch).length > 0) {
      t.update(deliveryMaterials)
        .set({ ...patch, updatedAt: audit.now, updatedBy: audit.userId })
        .where(eq(deliveryMaterials.id, row.id))
        .run();
    }
    // 标签并集（newTagNames 通道：同名词复用，新词免审批建 domain=material；K58）
    if (Array.isArray(out.tags)) {
      const names = [
        ...new Set(
          out.tags
            .filter((t2): t2 is string => typeof t2 === "string")
            .map((t2) => t2.trim())
            .filter((t2) => t2 !== "" && t2.length <= 50),
        ),
      ].slice(0, MAX_TAGS_APPLY);
      if (names.length > 0) {
        applyMaterialTags(t, row.id, { newTagNames: names }, audit, existingMaterialTagIds(t, row.id));
      }
    }
  });
}

/**
 * 单资料识别执行体（job handler 与直接调用共用）：
 * 抛错 → ai_status=failed 并上抛（job 落 failed）；skipped/ready 为正常终态。
 */
export async function enrichMaterial(
  db: Db,
  id: number,
  audit: { now: number; userId: number | null },
  opts: { fetchFn?: typeof fetch } = {},
): Promise<{ status: "ready" | "skipped"; message?: string }> {
  const row = getMaterialByIdAny(db, id);
  if (!row || row.deletedAt !== null) return { status: "skipped", message: "资料不存在或已删除" };
  if (row.kind !== "file" || !isPreviewableImage(row.contentType, row.originalFilename)) {
    return { status: "skipped", message: "非可预览图片" };
  }
  if (row.fileSize !== null && row.fileSize > MATERIAL_AI_ENRICH_MAX_BYTES) {
    setAiStatus(db, id, "skipped", audit);
    return { status: "skipped", message: "图片超尺寸阈值" };
  }
  const settings = resolveAssetsLlmSettings(db);
  if (!settings) {
    setAiStatus(db, id, "skipped", audit);
    return { status: "skipped", message: "LLM 未配置" };
  }
  const cfg = getMaterialsS3Config(db);
  if (!cfg?.enabled || !isS3RemoteReady(cfg)) {
    setAiStatus(db, id, "failed", audit);
    throw unprocessable("请先在系统设置中启用并保存资料存储配置");
  }
  try {
    const got = await s3GetObject(
      {
        endpoint: cfg.endpoint!,
        region: cfg.region,
        bucket: cfg.bucket!,
        accessKeyId: cfg.accessKeyId!,
        secretAccessKey: cfg.secretAccessKey!,
      } satisfies S3ClientConfig,
      row.objectKey!,
      { fetchFn: opts.fetchFn, timeoutMs: 60_000 },
    );
    const contentType = row.contentType || got.contentType || "image/png";
    const out = await chatJson<EnrichOutput>({
      settings,
      fetchFn: opts.fetchFn,
      temperature: 0.2,
      timeoutMs: 120_000,
      messages: [
        { role: "system", content: ENRICH_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: buildUserPrompt(db, row) },
            imagePart(got.body.toString("base64"), contentType),
          ],
        },
      ],
    });
    applyEnrichResult(db, row, out, audit);
    setAiStatus(db, id, "ready", audit, true);
    return { status: "ready" };
  } catch (err) {
    setAiStatus(db, id, "failed", audit);
    throw err;
  }
}
