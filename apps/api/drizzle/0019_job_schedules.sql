-- 2026-08 产品决策（K52）：定时任务。调度定义（cron 表达式 + 任务类型 + params + 启停 + last/next run）。
-- 调度器把到期 next_run_at 物化成 background_jobs（trigger='scheduled', trigger_spec=cron）行，
-- 执行器从 queued 队列串行消费，无感知（延续 K51 语义）。仅 admin 可维护。

CREATE TABLE job_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                      -- 任务类型 code（registry 驱动）
  params TEXT NOT NULL DEFAULT '{}',       -- JSON 参数（批量打标 = 列表 WHERE）
  cron TEXT NOT NULL,                      -- 5 字段 cron 表达式
  enabled INTEGER NOT NULL DEFAULT 1,      -- 1=启用, 0=停用
  last_run_at INTEGER,                     -- 上次触发（epoch ms UTC），可空
  next_run_at INTEGER,                     -- 下次触发（epoch ms UTC），可空
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (enabled IN (0, 1))
);

CREATE INDEX job_schedules_enabled_next_idx ON job_schedules(enabled, next_run_at);
