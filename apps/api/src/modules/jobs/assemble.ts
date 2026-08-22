// jobs 序列化 assembler（K21：JSON 一律 camelCase；GET list 项 = GET one = POST 响应）。
// params/progress/result 为 JSON 列：解析补全（progress 缺省 {0,0,0,0}）；createdBy 展开 live 用户（K9）。
import { and, inArray, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { UserRef } from "../users/assemble.js";
import { JOB_TYPES } from "./registry.js";
import type { JobRow } from "./repo.js";

export interface JobProgressDto {
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
}

export interface JobFailureDto {
  customerId: number;
  nickname: string;
  message: string;
}

export interface BackgroundJobDto {
  id: number;
  type: string;
  /** 注册表里的中文名；未注册类型为 null */
  typeLabel: string | null;
  params: Record<string, unknown>;
  status: string;
  progress: JobProgressDto;
  result: Record<string, unknown> | null;
  error: string | null;
  trigger: string;
  triggerSpec: string | null;
  createdBy: UserRef | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export const EMPTY_PROGRESS: JobProgressDto = { processed: 0, total: 0, succeeded: 0, failed: 0 };

function parseJsonObject(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toProgress(json: string): JobProgressDto {
  const p = parseJsonObject(json) ?? {};
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    processed: num(p.processed),
    total: num(p.total),
    succeeded: num(p.succeeded),
    failed: num(p.failed),
  };
}

function toDto(row: JobRow, refs: Map<number, UserRef>): BackgroundJobDto {
  return {
    id: row.id,
    type: row.type,
    typeLabel: JOB_TYPES[row.type]?.label ?? null,
    params: parseJsonObject(row.params) ?? {},
    status: row.status,
    progress: toProgress(row.progress),
    result: parseJsonObject(row.result),
    error: row.error,
    trigger: row.trigger,
    triggerSpec: row.triggerSpec,
    createdBy: row.createdBy === null ? null : (refs.get(row.createdBy) ?? null),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function assembleJobs(db: Db, rows: readonly JobRow[]): BackgroundJobDto[] {
  const ids = new Set<number>();
  for (const row of rows) {
    if (row.createdBy !== null) ids.add(row.createdBy);
  }
  const refs = new Map<number, UserRef>();
  if (ids.size > 0) {
    const found = db
      .select({ id: users.id, nickname: users.nickname })
      .from(users)
      .where(and(inArray(users.id, [...ids]), isNull(users.deletedAt)))
      .all();
    for (const u of found) refs.set(u.id, u);
  }
  return rows.map((row) => toDto(row, refs));
}

export function assembleJob(db: Db, row: JobRow): BackgroundJobDto {
  return assembleJobs(db, [row])[0]!;
}
