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

const pageAccessKeySchema = z.string().min(1).max(64);

export const pageAccessPatchSchema = z.object({
  roles: z.object({
    operator: z.array(pageAccessKeySchema).optional(),
    assistant: z.array(pageAccessKeySchema).optional(),
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
