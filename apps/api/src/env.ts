// 按设计文档 Rollout「环境变量」表全量解析 process.env。
// 拆两层（K5/K6 的落地需要）：
//   - scriptEnv：migrate / import 等脚本使用的宽松子集，不强制 SESSION_SECRET；
//   - appEnv：app 启动（index.ts / buildApp 生产路径）强制 SESSION_SECRET ≥ 32 字符。
// ADMIN_USERNAME / ADMIN_PASSWORD 的「何时必填」规则在 bootstrap-admin（PR 4）判定，这里只做解析。
import { z } from "zod";

const boolString = (defaultValue: boolean) =>
  z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true");

export const scriptEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_PATH: z.string().min(1).default("./data/gb-crm.sqlite"),
  // 生产静态资源目录（apps/web/dist）；默认按仓库布局推导，Docker 等场景可覆盖
  WEB_DIST: z.string().min(1).optional(),
  COOKIE_SECURE: boolString(false),
  TRUST_PROXY: boolString(false),
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  ADMIN_BOOTSTRAP_RESET_PASSWORD: boolString(false),
  CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  FEISHU_APP_ID: z.string().min(1).optional(),
  FEISHU_APP_SECRET: z.string().min(1).optional(),
  FEISHU_BASE_TOKEN: z.string().min(1).default("IWFEbuZcfalvQus6vkOcJXUjn2d"),
});

export const appEnvSchema = scriptEnvSchema.extend({
  // cookie 签名密钥（HMAC），< 32 字符拒绝启动
  SESSION_SECRET: z.string().min(32),
});

export type ScriptEnv = z.infer<typeof scriptEnvSchema>;
export type AppEnv = z.infer<typeof appEnvSchema>;

export function parseScriptEnv(env: NodeJS.ProcessEnv = process.env): ScriptEnv {
  return scriptEnvSchema.parse(env);
}

export function parseAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  return appEnvSchema.parse(env);
}
