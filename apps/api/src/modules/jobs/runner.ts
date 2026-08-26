// K51 后台任务执行器：进程内串行消费 queued 队列（单进程、无 worker pool，K32）。
// - pumpOnce()：领取一个 queued → running → 调 registry handler → 落终态；测试用（确定性）；
// - start()：recover()（重启残留 running → failed）+ 后台循环串行消费；生产 index.ts 调用；
// - handler 取消感知：isCancelled() 查 DB status；取消发生在 queued/running 时，running 的
//   由 handler 每迭代检查提前结束（当前客户 ≤30s LLM 调用会跑完）。
// - H3：finishJob 带 status='running' CAS，取消落在最后一次检查之后时，
//   循环走完的 succeeded/partial 与兜底 failed 都写不进去（静默跳过），cancelled 不可被覆盖。
import type { Db } from "../../db/client.js";
import { ApiError } from "../../plugins/error-handler.js";
import {
  claimNextJob,
  finishJob,
  getJobByIdAny,
  recoverInterruptedJobs,
  updateJobProgress,
  type JobRow,
} from "./repo.js";
import { JOB_TYPES, parseJobParams, type JobContext } from "./registry.js";

export interface JobRunnerOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒）；默认 Date.now() */
  now?: () => number;
  /** LLM / S3 客户端 fetch 注入（测试 mock）；默认全局 fetch */
  fetchFn?: typeof fetch;
}

export interface JobRunner {
  /** 生产：recover + 后台循环（start 幂等） */
  start: () => void;
  stop: () => void;
  /** 领取并同步执行一个 queued 任务到终态；无任务返回 null */
  pumpOnce: () => Promise<JobRow | null>;
  /** 重启恢复：残留 running → failed（启动时自动调用，测试可单独调） */
  recover: () => void;
}

function parseParams(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createJobRunner(opts: JobRunnerOptions): JobRunner {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());
  const fetchFn = opts.fetchFn;

  let stopped = true;

  const pumpOnce = async (): Promise<JobRow | null> => {
    const job = claimNextJob(db, now());
    if (!job) return null;

    const def = JOB_TYPES[job.type];
    if (!def) {
      finishJob(db, job.id, {
        status: "failed",
        error: `未知任务类型：${job.type}`,
        finishedAt: now(),
      });
      return job;
    }

    // handler 驱动终态；未正常结束（不 finish 就返回/抛未知错误）由 runner 兜底 failed
    let finished = false;
    const ctx: JobContext = {
      db,
      jobId: job.id,
      audit: { now: now(), userId: job.createdBy },
      fetchFn,
      isCancelled: () => getJobByIdAny(db, job.id)?.status === "cancelled",
      reportProgress: (p) => updateJobProgress(db, job.id, JSON.stringify(p)),
      finish: (status, payload) => {
        finished = true;
        finishJob(db, job.id, {
          status,
          result: payload.result !== undefined ? JSON.stringify(payload.result) : null,
          error: payload.error ?? null,
          finishedAt: now(),
        });
      },
    };

    try {
      // M11：执行侧复验 params（防排队期间代码演进后落库 params 与新 schema 不兼容）；
      // 校验失败抛 ApiError(VALIDATION)，由下方 catch 落 failed（中文 message）
      await def.run(ctx, parseJobParams(def, parseParams(job.params)));
    } catch (err) {
      if (!finished) {
        const message = err instanceof ApiError ? err.message : "服务器内部错误";
        finishJob(db, job.id, { status: "failed", error: message, finishedAt: now() });
      }
    }
    if (!finished) {
      finishJob(db, job.id, { status: "failed", error: "任务未正常结束", finishedAt: now() });
    }
    return job;
  };

  const recover = () => recoverInterruptedJobs(db, now());

  const start = () => {
    if (!stopped) return;
    stopped = false;
    recover();
    void (async () => {
      while (!stopped) {
        const job = await pumpOnce();
        if (!job) await sleep(500);
      }
    })();
  };

  const stop = () => {
    stopped = true;
  };

  return { start, stop, pumpOnce, recover };
}
