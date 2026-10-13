// K64 小程序客户同步配置（system_configs code='miniprogramSync'）编解码 + 就绪校验。
// value = { enabled, baseUrl, token, channelId, tagId, watermark: { updatedAtMs, lastId } }：
// - baseUrl/token：小程序后端（gb-backend）对外地址 + read 档 PAT（/agent/sql 只读端点）；
// - channelId/tagId：同步新建客户挂的来源渠道与客户标签（管理端先手工建好，这里只存 id）；
// - watermark：增量游标（源表 users 的 (updated_at, id) 元组），每批提交后由任务回写本行。
// 配置无独立管理 UI（K64 v1）：由 admin 经 agent SQL / REST 一次性写入；token 与 LLM apiKey
// 同级（库文件 chmod 600 + 内网），任何 API 响应不回读本行。
import type { Db } from "../../db/client.js";
import { unprocessable } from "../../plugins/error-handler.js";
import { findLiveChannelIds } from "../customers/repo.js";
import { getConfigRow, upsertConfigRow } from "../system/repo.js";
import { findLiveTagIds } from "../tags/repo.js";

export const MINIPROGRAM_SYNC_CONFIG_CODE = "miniprogramSync";

export interface MiniprogramSyncWatermark {
  /** 源表 users.updated_at 水位（epoch 毫秒；JS Date 毫秒精度，微秒级行由幂等重扫兜住） */
  updatedAtMs: number;
  /** 同水位内的 id tiebreak（源表 users.id） */
  lastId: number;
}

export interface MiniprogramSyncConfigValue {
  enabled: boolean;
  baseUrl: string | null;
  token: string | null;
  channelId: number | null;
  tagId: number | null;
  watermark: MiniprogramSyncWatermark;
}

/** 已校验齐备的同步配置（assertMiniprogramSyncReady 返回类型） */
export interface ReadyMiniprogramSyncConfig extends MiniprogramSyncConfigValue {
  baseUrl: string;
  token: string;
  channelId: number;
  tagId: number;
}

export const ZERO_WATERMARK: MiniprogramSyncWatermark = { updatedAtMs: 0, lastId: 0 };

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function parseWatermark(v: unknown): MiniprogramSyncWatermark {
  if (typeof v !== "object" || v === null) return { ...ZERO_WATERMARK };
  const obj = v as Record<string, unknown>;
  const updatedAtMs =
    typeof obj.updatedAtMs === "number" && Number.isFinite(obj.updatedAtMs) && obj.updatedAtMs >= 0
      ? Math.floor(obj.updatedAtMs)
      : 0;
  const lastId =
    typeof obj.lastId === "number" && Number.isInteger(obj.lastId) && obj.lastId >= 0
      ? obj.lastId
      : 0;
  return { updatedAtMs, lastId };
}

/** 读同步配置；行缺席 / JSON 损坏 / 非对象 → undefined（与 S3 配置同口径） */
export function getMiniprogramSyncConfig(db: Db): MiniprogramSyncConfigValue | undefined {
  const row = getConfigRow(db, MINIPROGRAM_SYNC_CONFIG_CODE);
  if (!row) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    baseUrl: strOrNull(obj.baseUrl),
    token: strOrNull(obj.token),
    channelId: intOrNull(obj.channelId),
    tagId: intOrNull(obj.tagId),
    watermark: parseWatermark(obj.watermark),
  };
}

/**
 * 任务推进水印：读-改-写整行 value（保留 baseUrl/token 等其它键）。
 * 配置行在运行期间被移除 → 422 中断本批（集成被拆不该静默继续）。
 */
export function saveMiniprogramSyncWatermark(
  db: Db,
  watermark: MiniprogramSyncWatermark,
  updatedAt: number,
  updatedBy: number | null,
): void {
  const current = getMiniprogramSyncConfig(db);
  if (!current) {
    throw unprocessable("小程序同步配置已不存在，水印无法落库", [
      { path: "miniprogramSync", message: "配置行被移除" },
    ]);
  }
  upsertConfigRow(
    db,
    MINIPROGRAM_SYNC_CONFIG_CODE,
    JSON.stringify({ ...current, watermark }),
    updatedAt,
    updatedBy,
  );
}

/**
 * 就绪校验（任务创建预检 + 执行前复验）：
 * 配置存在且 enabled、baseUrl/token 齐备、渠道/标签引用 live 行；任一不满足 → 422 中文明细。
 */
export function assertMiniprogramSyncReady(db: Db): ReadyMiniprogramSyncConfig {
  const cfg = getMiniprogramSyncConfig(db);
  if (!cfg) {
    throw unprocessable("请先配置小程序同步（system_configs code='miniprogramSync'）", [
      { path: "miniprogramSync", message: "缺少配置行" },
    ]);
  }
  if (!cfg.enabled) {
    throw unprocessable("小程序同步未启用（miniprogramSync.enabled=false）", [
      { path: "miniprogramSync.enabled", message: "未启用" },
    ]);
  }
  if (cfg.baseUrl === null || cfg.token === null) {
    throw unprocessable("小程序同步配置不完整", [
      { path: "miniprogramSync", message: "缺少 baseUrl 或 token（小程序后端 read 档 PAT）" },
    ]);
  }
  if (cfg.channelId === null || !findLiveChannelIds(db, [cfg.channelId]).has(cfg.channelId)) {
    throw unprocessable("小程序同步配置的来源渠道不存在或已删除", [
      { path: "miniprogramSync.channelId", message: "无效渠道 id" },
    ]);
  }
  if (cfg.tagId === null || !findLiveTagIds(db, [cfg.tagId]).has(cfg.tagId)) {
    throw unprocessable("小程序同步配置的客户标签不存在或已删除", [
      { path: "miniprogramSync.tagId", message: "无效标签 id" },
    ]);
  }
  return {
    ...cfg,
    baseUrl: cfg.baseUrl,
    token: cfg.token,
    channelId: cfg.channelId,
    tagId: cfg.tagId,
  };
}
