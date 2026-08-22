-- 2026-08 产品决策（K51）：后台任务系统。手动触发批量打标改后台任务；
-- 未来定时任务直接插 trigger='scheduled' 行，执行器从 queued 队列串行消费，无感知。
-- 状态机：queued → running → succeeded | partial | failed | cancelled。
-- 进程重启：runner 启动时 recover() 把残留 running → failed（error 注明重启中断）。

CREATE TABLE background_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                      -- 任务类型 code（registry 驱动）
  params TEXT NOT NULL DEFAULT '{}',       -- JSON 参数（批量打标 = 列表 WHERE）
  status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT NOT NULL DEFAULT '{}',     -- JSON { processed, total, succeeded, failed }
  result TEXT,                             -- JSON 结果（批量打标 = { total,succeeded,failed,failures }）
  error TEXT,                              -- 失败原因（中文，可直接 Toast）
  trigger TEXT NOT NULL DEFAULT 'manual',  -- manual / scheduled（未来定时任务预留）
  trigger_spec TEXT,                       -- 定时表达式说明（未来 cron，本期恒 NULL）
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  CHECK (trigger IN ('manual','scheduled'))
);

CREATE INDEX background_jobs_status_idx ON background_jobs(status);
CREATE INDEX background_jobs_created_idx ON background_jobs(created_at DESC);
