// 生产入口：parseAppEnv → 建库 → migrate → bootstrap（拒启则退出码非零）→ listen。
// K51：启动后台任务执行器（进程内串行消费 background_jobs queued 队列；启动时恢复残留 running）。
import { buildApp } from "./app.js";
import { bootstrapAdmin } from "./db/bootstrap-admin.js";
import { createDb } from "./db/client.js";
import { migrateDb } from "./db/migrate.js";
import { parseAppEnv } from "./env.js";
import { createJobRunner } from "./modules/jobs/runner.js";
import { createJobScheduler } from "./modules/jobs/scheduler.js";

const env = parseAppEnv();
const { db, sqlite, close } = createDb(env.DATABASE_PATH);
migrateDb(sqlite);

const app = buildApp({ env, db, logger: { level: env.LOG_LEVEL } });

const jobRunner = createJobRunner({ db, now: () => Date.now() });
jobRunner.start();
// K52：调度器把到期 job_schedules 物化成 trigger='scheduled' 队列行；执行器无感知。
const jobScheduler = createJobScheduler({ db, now: () => Date.now() });
jobScheduler.start();

try {
  await bootstrapAdmin(db, env, { log: (m) => app.log.info(m) });
} catch (err) {
  app.log.error(err);
  close();
  process.exit(1); // bootstrap 拒启：退出码非零
}

// K20/K32：非 loopback 且未 COOKIE_SECURE → warn，不拒启
const loopback = env.HOST === "127.0.0.1" || env.HOST === "::1" || env.HOST === "localhost";
if (!loopback && !env.COOKIE_SECURE) {
  app.log.warn("non-loopback bind without COOKIE_SECURE; put TLS in front");
}

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.error(err);
  close();
  process.exit(1);
}
