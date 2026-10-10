import { z } from "zod";

import {
  deliveryTypeKindSchema,
  materialAiStatusSchema,
  MATERIAL_FILE_KIND,
  MATERIAL_TEXT_KINDS,
  materialKindSchema,
} from "../enums.js";
import { folderPathSchema } from "./material-folder.js";
import { epochMsSchema, pageQuerySchema } from "./common.js";

// K54 交付资料（delivery_materials 表，camelCase）。
// 文本类（transcript/text）content 可空（创建后可在全文编辑器页补写）；媒体类（audio/video/link）url 必填。
// K57：kind=file 对象存储，JSON POST 拒绝（走 multipart 上传接口）。
// 关联可空：deliveryId 可空（孤儿资料），customerIds M2M 0..N（PATCH：缺席不动、[] 清空）。
// K63：description 文字描述（入 FTS）；folderId/folderPath 归档（folderPath 仅创建/上传时接受，
// 逐级缺则自动建——agent 免查 id；PATCH 只认 folderId，防改一条资料顺手建目录链）。

const idArraySchema = z.array(z.number().int().positive());

const materialBaseSchema = z.object({
  kind: materialKindSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().max(2_000_000).nullish(),
  url: z.string().trim().min(1).max(1000).nullish(),
  /** K63 文字描述（≤2000 字，入 FTS；null 清空） */
  description: z.string().max(2_000).nullish(),
  /** K63 归档文件夹；null = 移回未分类 */
  folderId: z.number().int().positive().nullish(),
  deliveryId: z.number().int().positive().nullish(),
  customerIds: idArraySchema.optional(),
  /** K58：资料标签。缺席=不动；[]=清空；[ids]=整表替换。id 必须是 domain=material 的 live 词 */
  tagIds: idArraySchema.optional(),
  /** 运营可随手建资料词（只进 domain=material）；与 tagIds 合并去重 */
  newTagNames: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
});

export const materialWriteSchema = materialBaseSchema
  .extend({
    /** K63：仅创建时接受；逐级缺则自动建文件夹链，优先级高于 folderId */
    folderPath: folderPathSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === MATERIAL_FILE_KIND) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "对象存储类型请通过上传接口创建",
      });
      return;
    }
    const textKind = (MATERIAL_TEXT_KINDS as readonly string[]).includes(v.kind);
    if (!textKind && !v.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "媒体类资料必须填写链接" });
    }
  });
export type MaterialWrite = z.infer<typeof materialWriteSchema>;

/** 对象存储上传的元信息（multipart 文本字段；kind 固定为 file） */
export const materialUploadMetaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullish(),
  folderId: z.number().int().positive().nullish(),
  folderPath: folderPathSchema.optional(),
  deliveryId: z.number().int().positive().nullish(),
  customerIds: idArraySchema.optional(),
  tagIds: idArraySchema.optional(),
  newTagNames: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  /**
   * K63 AI 识别开关：缺席/true → 图片自动入队 vision 识别（LLM 未配置静默跳过 aiStatus=skipped）；
   * false → 完全不碰（aiStatus 保持 null）。agent 自带元数据时可显式关闭省一次识别。
   */
  aiEnrich: z.boolean().optional(),
});
export type MaterialUploadMeta = z.infer<typeof materialUploadMetaSchema>;

/** material-ai-enrich 任务参数（单资料识别；重跑= 再入队一个） */
export const materialAiEnrichJobParamsSchema = z
  .object({ materialId: z.number().int().positive() })
  .strict();
export type MaterialAiEnrichJobParams = z.infer<typeof materialAiEnrichJobParamsSchema>;

/** material-file-meta-backfill 任务参数（存量回填；enrich=true 顺带给未识别图片排队 AI 识别） */
export const materialMetaBackfillJobParamsSchema = z
  .object({ enrich: z.boolean().optional() })
  .strict();
export type MaterialMetaBackfillJobParams = z.infer<typeof materialMetaBackfillJobParamsSchema>;

// PATCH 内核（K24）：.partial() 只表示键可缺席；kind↔content/url 组合校验在 service 合并后重跑
// （folderPath 不在 PATCH 白名单——移动/归档用 folderId）
export const materialPatchSchema = materialBaseSchema.partial().extend({
  updatedAt: epochMsSchema,
});
export type MaterialPatch = z.infer<typeof materialPatchSchema>;

export const materialSortSchema = z.enum(["updatedAt", "createdAt", "title"]);

/** query 里的逗号分隔正整数列表（tagIds=1,2,3 → [1,2,3]） */
const csvIdListSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((val, ctx): number[] => {
    const ids: number[] = [];
    for (const part of val.split(",")) {
      const n = Number(part.trim());
      if (part.trim() === "" || !Number.isInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: "必须是逗号分隔的正整数列表" });
        return [];
      }
      ids.push(n);
    }
    return ids;
  });

/** query 里的逗号分隔名字列表（中英文逗号都可；tagNames=活动,海报 → [活动,海报]） */
const csvNameListSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((val) =>
    val
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );

export const materialListQuerySchema = pageQuerySchema.extend({
  sort: materialSortSchema.optional(),
  kind: materialKindSchema.optional(),
  deliveryId: z.coerce.number().int().positive().optional(),
  customerId: z.coerce.number().int().positive().optional(),
  /**
   * 按关联交付的类型 kind 过滤（咨询/活动/圈子/其他）：
   * consulting/activity/circle 只命中对应类型；other = 未关联（无交付或交付软删/类型软删）或类型本身为 other。
   */
  deliveryKind: deliveryTypeKindSchema.optional(),
  /** orphan=1：只看未完整关联的资料（无交付单或无客户） */
  orphan: z.enum(["1"]).optional(),
  /** K58：按资料标签等值过滤（单个） */
  tagId: z.coerce.number().int().positive().optional(),
  /** K63：按资料标签 AND 过滤（逗号分隔，须全部命中） */
  tagIds: csvIdListSchema.optional(),
  /** K63：按资料标签名 AND 过滤（逗号分隔，名字解析不到 live material 域词 → 结果为空） */
  tagNames: csvNameListSchema.optional(),
  /** K63：归档文件夹过滤；0 = 未分类 */
  folderId: z.coerce.number().int().min(0).optional(),
  /** K63：按路径过滤（如 客户A/下午茶）；路径解析不到 → 结果为空 */
  folderPath: folderPathSchema.optional(),
  /** K63：sha256 hex 等值过滤（上传前防重预查） */
  checksum: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "必须是 sha256 hex")
    .optional(),
  /** K63：AI 识别状态过滤（筛失败重跑用） */
  aiStatus: materialAiStatusSchema.optional(),
});
export type MaterialListQuery = z.infer<typeof materialListQuerySchema>;

