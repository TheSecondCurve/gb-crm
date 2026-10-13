// K64 小程序客户同步执行核心（miniprogram-users-sync 任务）：
// CRM 侧拉模式——经小程序后端 /agent/sql 只读端点（read 档 PAT）按 (updated_at, id) 水印
// 增量拉 users 行，upsert 进 customers。低风险纪律：
// - 匹配顺序：wechat_openid（已链接）→ phone 精确（链接老客）→ 新建；
// - 只新建 + 只填空，永不覆盖人工维护的昵称/手机等字段；
// - 软删客户不复活（openid 命中软删行 → 跳过），源端硬删不回传；
// - 每批处理完推进并落库水印，任务失败/取消后从水印续跑，upsert 幂等。
import type { Db } from "../../db/client.js";
import { createAudit, type AuditContext } from "../../lib/audit.js";
import { ApiError, upstreamError } from "../../plugins/error-handler.js";
import { insertRecord } from "../customer-records/repo.js";
import { createCustomer } from "../customers/service.js";
import {
  assertMiniprogramSyncReady,
  saveMiniprogramSyncWatermark,
  ZERO_WATERMARK,
  type MiniprogramSyncWatermark,
  type ReadyMiniprogramSyncConfig,
} from "./config.js";
import {
  ensureCustomerSourceChannel,
  ensureCustomerTag,
  fillCustomerPhoneIfEmpty,
  findAnyByWechatOpenid,
  findLiveByPhoneWithoutOpenid,
  linkCustomerOpenid,
} from "./repo.js";

/** 单批拉取行数（远端 1000 行硬上限之下留余量） */
export const SYNC_BATCH_SIZE = 500;
/** 远端语句自带 10s 超时，客户端再放宽到 20s 兜底网络抖动 */
const FETCH_TIMEOUT_MS = 20_000;
/** result.failures 明细上限（防大批次故障撑爆 result 列） */
const FAILURE_DETAIL_MAX = 20;

export interface MiniprogramSyncFailure {
  userId: number | null;
  openid: string | null;
  message: string;
}

export interface MiniprogramSyncJobResult {
  /** 源侧待同步总数（count 查询） */
  total: number;
  /** 本次实际处理行数 */
  scanned: number;
  created: number;
  /** phone 精确匹配上老客户、回填 openid */
  linked: number;
  /** 已链接客户回填了空手机号 */
  filled: number;
  /** openid 命中软删客户，跳过（不复活） */
  skippedDeleted: number;
  failed: number;
  failures: MiniprogramSyncFailure[];
  /** 本次推进到的水印（已落库） */
  watermark: MiniprogramSyncWatermark;
  cancelled: boolean;
}

export interface MiniprogramSyncJobOptions {
  fetchFn?: typeof fetch;
  isCancelled?: () => boolean;
  onProgress?: (p: { processed: number; total: number; succeeded: number; failed: number }) => void;
}

// ---- 源端查询（/agent/sql：单语句只读；水印只插数值字面量，无字符串注入面） ----

function watermarkWhere(wm: MiniprogramSyncWatermark): string {
  const sec = wm.updatedAtMs / 1000;
  return `openid IS NOT NULL
    AND (updated_at > to_timestamp(${sec}) OR (updated_at = to_timestamp(${sec}) AND id > ${wm.lastId}))`;
}

function buildCountQuery(wm: MiniprogramSyncWatermark): string {
  return `SELECT count(*) AS n FROM users WHERE ${watermarkWhere(wm)}`;
}

function buildBatchQuery(wm: MiniprogramSyncWatermark): string {
  return `SELECT id, openid, nickname, phone, created_at, updated_at FROM users
WHERE ${watermarkWhere(wm)}
ORDER BY updated_at ASC, id ASC
LIMIT ${SYNC_BATCH_SIZE}`;
}

interface AgentSqlPayload {
  columns: string[];
  rows: unknown[][];
}

/** 调小程序后端 /agent/sql（裸信封 {columns,rows,...}，非 CRM 的 {data} 封装）；失败 → 502 UPSTREAM_ERROR */
async function agentSql(
  cfg: ReadyMiniprogramSyncConfig,
  sql: string,
  fetchFn: typeof fetch | undefined,
): Promise<AgentSqlPayload> {
  const call = fetchFn ?? fetch;
  let res: Response;
  try {
    res = await call(`${cfg.baseUrl.replace(/\/+$/, "")}/agent/sql`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw upstreamError(`小程序后端网络异常：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body: unknown = await res.json();
      const obj = body as Record<string, unknown>;
      const errObj = obj.error as Record<string, unknown> | undefined;
      detail =
        (typeof errObj?.message === "string" && errObj.message) ||
        (typeof obj.message === "string" && obj.message) ||
        "";
    } catch {
      // 非 JSON 错误体，仅保留状态码
    }
    if (res.status === 401 || res.status === 403) {
      throw upstreamError(
        `小程序后端鉴权失败（HTTP ${res.status}）：PAT 过期或被吊销，请重新签发后更新同步配置`,
      );
    }
    throw upstreamError(
      `小程序后端查询失败（HTTP ${res.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`,
    );
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw upstreamError("小程序后端返回格式异常（非 JSON）");
  }
  const obj = payload as Partial<AgentSqlPayload>;
  if (!Array.isArray(obj.columns) || !Array.isArray(obj.rows)) {
    throw upstreamError("小程序后端返回格式异常（缺 columns/rows）");
  }
  return { columns: obj.columns, rows: obj.rows };
}

// ---- 行解析 ----

interface SourceUser {
  id: number;
  openid: string;
  nickname: string | null;
  phone: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

function parseMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return Number.NaN;
}

/** 源行（数组，顺序对齐查询列）→ 结构体；无法解析返回 null（计数为失败行） */
function parseSourceUser(row: unknown[]): SourceUser | null {
  const [idRaw, openidRaw, nicknameRaw, phoneRaw, createdRaw, updatedRaw] = row;
  const id = typeof idRaw === "string" || typeof idRaw === "number" ? Number(idRaw) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) return null;
  if (typeof openidRaw !== "string" || openidRaw.trim() === "") return null;
  const updatedAtMs = parseMs(updatedRaw);
  if (Number.isNaN(updatedAtMs)) return null;
  const createdAtMs = parseMs(createdRaw);
  const text = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  return {
    id,
    openid: openidRaw.trim(),
    nickname: text(nicknameRaw),
    phone: text(phoneRaw),
    createdAtMs: Number.isNaN(createdAtMs) ? updatedAtMs : createdAtMs,
    updatedAtMs,
  };
}

// ---- 单行 upsert ----

type SyncOutcome = "created" | "linked" | "filled" | "skippedDeleted" | "noop";

function inTx<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction((tx) => fn(tx as unknown as Db));
}

/**
 * 单行同步（每行独立事务，一行坏不拖垮整批）：
 * openid 命中 live → 只填空 + 补渠道/标签；命中软删 → 跳过；
 * 否则 phone 精确匹配 → 链接；都没有 → 新建（渠道 + 标签 + lead 记录锚定注册时间）。
 */
function syncOneUser(
  db: Db,
  user: SourceUser,
  cfg: ReadyMiniprogramSyncConfig,
  ctx: AuditContext,
): SyncOutcome {
  const audit = createAudit(ctx);
  return inTx(db, (tx) => {
    const byOpenid = findAnyByWechatOpenid(tx, user.openid);
    if (byOpenid) {
      if (byOpenid.deletedAt !== null) return "skippedDeleted";
      const filled =
        user.phone !== null
          ? fillCustomerPhoneIfEmpty(tx, byOpenid.id, user.phone, {
              updatedAt: audit.updatedAt,
              updatedBy: audit.updatedBy,
            })
          : 0;
      ensureCustomerSourceChannel(tx, byOpenid.id, cfg.channelId);
      ensureCustomerTag(tx, byOpenid.id, cfg.tagId, {
        createdAt: audit.createdAt,
        createdBy: audit.createdBy,
      });
      return filled > 0 ? "filled" : "noop";
    }

    if (user.phone !== null) {
      const candidate = findLiveByPhoneWithoutOpenid(tx, user.phone);
      if (candidate) {
        const changes = linkCustomerOpenid(tx, candidate.id, user.openid, {
          updatedAt: audit.updatedAt,
          updatedBy: audit.updatedBy,
        });
        if (changes === 0) {
          throw new Error(`客户#${candidate.id} 链接 openid 时发生并发冲突`);
        }
        ensureCustomerSourceChannel(tx, candidate.id, cfg.channelId);
        ensureCustomerTag(tx, candidate.id, cfg.tagId, {
          createdAt: audit.createdAt,
          createdBy: audit.createdBy,
        });
        return "linked";
      }
    }

    const dto = createCustomer(
      tx,
      {
        nickname: user.nickname ?? `小程序用户${user.id}`,
        phone: user.phone,
        customerType: "customer",
        wechatOpenid: user.openid,
        sourceChannelIds: [cfg.channelId],
        tagIds: [cfg.tagId],
      },
      ctx,
    );
    // 注册时间锚点（K55 lead）：不触发 last_followed_at 刷新——注册不是销售跟进
    insertRecord(tx, {
      customerId: dto.id,
      kind: "lead",
      happenedAt: user.createdAtMs,
      content: "小程序注册（自动同步）",
      createdAt: audit.createdAt,
      updatedAt: audit.updatedAt,
      createdBy: audit.createdBy,
      updatedBy: audit.updatedBy,
    });
    return "created";
  });
}

// ---- 任务主循环 ----

/**
 * 同步主流程：就绪校验 → count（进度总数）→ 按水印分批拉取 → 逐行 upsert → 批末落水印。
 * params.full=true 从零点水印全量重扫（幂等）。取消时按已处理行落水印后以 cancelled 结束。
 */
export async function runMiniprogramSyncJob(
  db: Db,
  params: { full?: boolean },
  ctx: AuditContext,
  opts: MiniprogramSyncJobOptions = {},
): Promise<MiniprogramSyncJobResult> {
  const cfg = assertMiniprogramSyncReady(db);
  let wm = params.full === true ? { ...ZERO_WATERMARK } : cfg.watermark;

  const result: MiniprogramSyncJobResult = {
    total: 0,
    scanned: 0,
    created: 0,
    linked: 0,
    filled: 0,
    skippedDeleted: 0,
    failed: 0,
    failures: [],
    watermark: wm,
    cancelled: false,
  };
  const report = () =>
    opts.onProgress?.({
      processed: result.scanned,
      total: result.total,
      succeeded: result.created + result.linked + result.filled,
      failed: result.failed,
    });

  const countPayload = await agentSql(cfg, buildCountQuery(wm), opts.fetchFn);
  result.total = Number(countPayload.rows[0]?.[0] ?? 0) || 0;
  report();
  if (result.total === 0) return result;

  for (;;) {
    if (opts.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    const payload = await agentSql(cfg, buildBatchQuery(wm), opts.fetchFn);
    if (payload.rows.length === 0) break;

    // 本批最后处理成功的行（取消/失败时水印只能推进到它，防跳行）
    let lastProcessed: SourceUser | null = null;
    for (const raw of payload.rows) {
      if (opts.isCancelled?.()) {
        result.cancelled = true;
        break;
      }
      const user = parseSourceUser(raw);
      if (user === null) {
        result.failed += 1;
        pushFailure(result, { userId: null, openid: null, message: "源行无法解析" });
        report();
        continue;
      }
      try {
        const outcome = syncOneUser(db, user, cfg, ctx);
        if (outcome === "created") result.created += 1;
        else if (outcome === "linked") result.linked += 1;
        else if (outcome === "filled") result.filled += 1;
        else if (outcome === "skippedDeleted") result.skippedDeleted += 1;
      } catch (err) {
        result.failed += 1;
        pushFailure(result, {
          userId: user.id,
          openid: user.openid,
          message: err instanceof ApiError ? err.message : String(err),
        });
        report();
        continue;
      }
      result.scanned += 1;
      lastProcessed = user;
      report();
    }

    if (lastProcessed !== null) {
      wm = { updatedAtMs: lastProcessed.updatedAtMs, lastId: lastProcessed.id };
      saveMiniprogramSyncWatermark(db, wm, ctx.now, ctx.userId);
      result.watermark = wm;
    }
    if (result.cancelled || payload.rows.length < SYNC_BATCH_SIZE) break;
  }
  return result;
}

function pushFailure(result: MiniprogramSyncJobResult, failure: MiniprogramSyncFailure): void {
  if (result.failures.length < FAILURE_DETAIL_MAX) result.failures.push(failure);
}
