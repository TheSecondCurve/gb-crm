// K62 客户洞察 —— API 请求 schema（透视台查询 / 信号读写 / 词表）。
// 注意：query 参数一律以字符串到达，数值型枚举必须 coerce（window 的 z.literal 陷阱已在生产踩过）。
import { z } from "zod";

import { signalSourceTypeSchema, signalTypeSchema } from "../enums.js";
import { INSIGHT_WINDOWS, PIVOT_AXIS_KEYS } from "../insights.js";
import type { InsightWindow, PivotAxisKey } from "../insights.js";

// ── 透视台 ──
export const pivotQuerySchema = z.object({
  x: z.enum(PIVOT_AXIS_KEYS as unknown as [PivotAxisKey, ...PivotAxisKey[]]).default("city"),
  y: z.enum(PIVOT_AXIS_KEYS as unknown as [PivotAxisKey, ...PivotAxisKey[]]).default("stageTag"),
  window: z
    .coerce.number()
    .refine((v) => (INSIGHT_WINDOWS as readonly number[]).includes(v), "window 必须是 30/90/180/365")
    .default(90),
  ownerId: z.coerce.number().int().positive().optional(),
});
export type PivotQuery = z.infer<typeof pivotQuerySchema>;
export type { InsightWindow, PivotAxisKey };

// ── 深潜 ──
export const insightDepthParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** 分页大小（query 传字符串，coerce 后限定 25/50/100） */
const pageSizeSchema = z
  .coerce.number()
  .refine((v) => v === 25 || v === 50 || v === 100, "pageSize 必须是 25/50/100")
  .default(50);

// ── 信号 ──
export const signalsListQuerySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  type: signalTypeSchema.optional(),
  /** 默认只看有效（未被取代/未否决/未过期）；false = 全量历史 */
  active: z
    .union([z.literal("true"), z.literal("false")])
    .default("true")
    .transform((v) => v === "true"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: pageSizeSchema,
});
export type SignalsListQuery = z.infer<typeof signalsListQuerySchema>;

/** 人工补录信号（K62：直生 active，置信度 1） */
export const signalManualWriteSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  type: signalTypeSchema,
  /** 归一主题词名（可空 = 无主题）；词表没有则直接建（免审批，对齐资料标签模式） */
  topic: z.string().trim().min(1).max(40).optional(),
  content: z.string().trim().min(1).max(500),
  /** 事实发生时间（epoch ms）；缺省 = 现在 */
  sourceAt: z.coerce.number().int().positive().optional(),
});
export type SignalManualWrite = z.infer<typeof signalManualWriteSchema>;

export const signalIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** 抽取入参（LLM 输出 → ingest 前的内部形状；也用于测试直调） */
export const signalExtractionSchema = z.object({
  type: signalTypeSchema,
  /** 归一主题词名；新词时必须同时给 nearest（最近现有词名，可空） */
  topic: z.string().trim().min(1).max(40).optional(),
  topicNearest: z.string().trim().min(1).max(40).optional(),
  content: z.string().trim().min(1).max(500),
  confidence: z.number().min(0).max(1).default(1),
  sourceType: signalSourceTypeSchema,
  /** 出处行 id（origin_story/note/manual 为 null） */
  sourceId: z.number().int().positive().nullish(),
  /** 原文发生时间（epoch ms） */
  sourceAt: z.number().int().positive(),
});
export type SignalExtraction = z.infer<typeof signalExtractionSchema>;

export const signalExtractJobParamsSchema = z
  .object({
    /** 指定客户（即时通道：记录新建/编辑后单客户重抽） */
    customerId: z.coerce.number().int().positive().optional(),
    /** 全量回填（存量刷数） */
    all: z.coerce.boolean().default(false),
  })
  .strict();
export type SignalExtractJobParams = z.infer<typeof signalExtractJobParamsSchema>;

// ── 词表 ──
export const signalTopicsListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: pageSizeSchema,
});

/** 同义词合并：把本词并入 intoId（历史信号与 related 边全部改指；本词软删） */
export const signalTopicMergeSchema = z.object({
  intoId: z.coerce.number().int().positive(),
});
