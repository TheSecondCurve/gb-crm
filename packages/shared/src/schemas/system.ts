import { z } from "zod";

// K46 LLM 打标配置（ai_config 单行表，OpenAI 兼容接口）。
// GET 响应：apiKey 永不全量返回，只回 apiKeySet + 掩码 apiKeyMasked。
// PATCH：单行、单管理员，有意不做 OCC（偏离 K24 内核，见 modules/system 注释）。

export const aiConfigGetSchema = z.object({
  provider: z.string().nullable(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  apiKeySet: z.boolean(),
  apiKeyMasked: z.string().nullable(),
});
export type AiConfigGet = z.infer<typeof aiConfigGetSchema>;

export const aiConfigPatchSchema = z.object({
  provider: z.string().trim().max(100).nullable().optional(),
  baseUrl: z.string().trim().max(500).nullable().optional(),
  model: z.string().trim().max(100).nullable().optional(),
  /** 传非空串才更新 key；空串/缺席保留旧值（placeholder 语义） */
  apiKey: z.string().trim().min(1).max(500).optional(),
});
export type AiConfigPatch = z.infer<typeof aiConfigPatchSchema>;

// ── 角色→页面权限（配置层：前端功能级权限；安全层仍为 can()）──
// 存储为 system_configs code='pageAccess'（value = { operator: string[], assistant: string[] }）。
// admin 固定全量，不参与配置（防锁死管理页）。配置只能在各角色 can() 允许集内收缩。

// ── S3 兼容对象存储（远程备份，K53）──
// 存储为 system_configs code='s3'（value = { enabled, endpoint, region, bucket, prefix,
// accessKeyId, secretAccessKey }）。GET 掩码同 LLM 配置：secretAccessKey 永不全量返回。
// PATCH：secretAccessKey 空/缺席保留旧值（placeholder 语义）；enabled=true 时四要素必须齐
// （endpoint/bucket/accessKeyId/secretAccessKey，服务端完整性校验 422）。

export const s3ConfigGetSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  /** 归一化后的对象 key 前缀："" 或 "xxx/"（无开头斜杠） */
  prefix: z.string().nullable(),
  accessKeyId: z.string().nullable(),
  secretKeySet: z.boolean(),
  secretKeyMasked: z.string().nullable(),
});
export type S3ConfigGet = z.infer<typeof s3ConfigGetSchema>;

const httpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\/\S+$/.test(v), { message: "Endpoint 必须是 http(s) 地址" });

/** 桶名字符集放宽到主流兼容实现（MinIO/OSS/COS/R2），仅挡空格与路径分隔符 */
const bucketNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Bucket 名只能包含字母、数字、点、下划线、连字符");

export const s3ConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: httpUrlSchema.nullable().optional(),
  region: z.string().trim().max(100).nullable().optional(),
  bucket: bucketNameSchema.nullable().optional(),
  /** 服务端归一化为 "" 或 "xxx/"（去首尾/重复斜杠） */
  prefix: z.string().trim().max(400).nullable().optional(),
  accessKeyId: z.string().trim().max(200).nullable().optional(),
  /** 传非空串才更新；空串/缺席保留旧值（placeholder 语义，同 LLM apiKey） */
  secretAccessKey: z.string().trim().min(1).max(500).optional(),
});
export type S3ConfigPatch = z.infer<typeof s3ConfigPatchSchema>;

export const s3TestResultSchema = z.object({
  ok: z.literal(true),
  /** 实际探测写入又删除的对象 key */
  probeKey: z.string(),
});
export type S3TestResult = z.infer<typeof s3TestResultSchema>;

const pageAccessKeySchema = z.string().min(1).max(64);

export const pageAccessPatchSchema = z.object({
  roles: z.object({
    // H5：至少保留一个页面，防止把角色配成空集导致该角色登录后无处可去
    operator: z.array(pageAccessKeySchema).min(1).optional(),
    assistant: z.array(pageAccessKeySchema).min(1).optional(),
  }),
});
export type PageAccessPatch = z.infer<typeof pageAccessPatchSchema>;

const rolePageStateSchema = z.object({
  /** can() 硬下限允许的菜单页 */
  allowed: z.array(pageAccessKeySchema),
  /** 配置后实际生效的菜单页（⊆ allowed） */
  enabled: z.array(pageAccessKeySchema),
});

export const pageAccessGetSchema = z.object({
  roles: z.object({
    operator: rolePageStateSchema,
    assistant: rolePageStateSchema,
  }),
});
export type PageAccessGet = z.infer<typeof pageAccessGetSchema>;
