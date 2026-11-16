// K68 语料同步端点 query schema（/api/v1/corpus/documents）。
// 面向外部大脑的拉模式变更流：updatedSince 增量水位（严格 >）+ 墓碑行（软删语料
// 以 { id, deleted: true, updatedAt } 进流，消费方按 id 幂等 upsert / 移除）。
import { z } from "zod";

import { deliveryTypeKindSchema } from "../enums.js";
import { csvIdListSchema, csvNameListSchema, pageQuerySchema } from "./common.js";

/** include=content 时的分页上限（transcript 单条可达数万字，防巨响应） */
export const CORPUS_CONTENT_MAX_PAGE_SIZE = 25;

export const corpusDocumentsQuerySchema = pageQuerySchema
  .extend({
    /** 增量水位（epoch 毫秒，严格 >；缺席 = 全量。翻完所有页后用最后一页 meta.nextSince 接力） */
    updatedSince: z.coerce.number().int().min(0).optional(),
    /** 内联全文；未带则 content=null（只有 contentLength） */
    include: z.enum(["content"]).optional(),
    /** 资料标签 AND 过滤（只作用于 live 行，墓碑不受过滤影响） */
    tagIds: csvIdListSchema.optional(),
    tagNames: csvNameListSchema.optional(),
    /** 按关联交付类型过滤（consulting/activity/circle/other，语义同资料专区） */
    deliveryKind: deliveryTypeKindSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.include === "content" && v.pageSize > CORPUS_CONTENT_MAX_PAGE_SIZE) {
      ctx.addIssue({
        code: "custom",
        path: ["pageSize"],
        message: `include=content 时 pageSize 上限为 ${CORPUS_CONTENT_MAX_PAGE_SIZE}`,
      });
    }
  });
export type CorpusDocumentsQuery = z.infer<typeof corpusDocumentsQuerySchema>;
