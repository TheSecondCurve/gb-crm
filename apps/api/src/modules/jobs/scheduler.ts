// K52 后台任务调度器：进程内把到期的调度定义物化成 background_jobs（trigger='scheduled'）行。
// - 与执行器解耦：只产队列行，执行器照常从 queued 串行消费，无感知；
// - tick()：取 enabled 且 next_run_at ≤ now 的调度 → CAS 推进 next_run_at → 插队列行（created_by=NULL）；
//   CAS 影响 0 行（并发/已结束）静默跳过，防重复插行；
// - 漏跑补偿：推进时用 now() 求下一触发（而非 fireAt），停机错过只补跑一次，不连追；
// - start()：幂等后台循环（1s tick），生产 index.ts 调用；测试用 tick() 确定性验证。
import type { Db } from "../../db/client.js";
import { cronNext } from "../../lib/cron.js";
import { insertJob } from "./repo.js";
import {
  advanceJobScheduleRun,
  listDueJobSchedules,
} from "./schedule-repo.js";

export interface JobSchedulerOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒）；默认 Date.now() */
  now?: () => number;
}

export interface JobScheduler {
  /** 生产：后台循环 tick（start 幂等） */
  start: () => void;
  stop: () => void;
  /** 领取并物化一次到期调度；返回本次触发条数（测试用） */
  tick: () => number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createJobScheduler(opts: JobSchedulerOptions): JobScheduler {
  const { db } = opts;
  const now = opts.now ?? (() => Date.now());

  let stopped = true;

  const tick = (): number => {
    let fired = 0;
    for (const schedule of listDueJobSchedules(db, now())) {
      const fireAt = schedule.nextRunAt;
      if (fireAt === null) continue;
      // 用 now() 求下一触发：停机/延后只补跑一次，next_run_at 直接推进到当前时刻之后，避免连追
      const next = cronNext(schedule.cron, now());
      // CAS 推进；0 行 = 已被并发推进/结束，跳过（此时不得再插行，防重复）
      const claimed = advanceJobScheduleRun(db, schedule.id, fireAt, next, now());
      if (claimed === 0) continue;
      insertJob(db, {
        type: schedule.type,
        params: schedule.params,
        status: "queued",
        progress: "{}",
        trigger: "scheduled",
        triggerSpec: schedule.cron,
        createdAt: now(),
        createdBy: null,
      });
      fired += 1;
    }
    return fired;
  };

  const start = () => {
    if (!stopped) return;
    stopped = false;
    void (async () => {
      while (!stopped) {
        tick();
        await sleep(1000);
      }
    })();
  };

  const stop = () => {
    stopped = true;
  };

  return { start, stop, tick };
}
