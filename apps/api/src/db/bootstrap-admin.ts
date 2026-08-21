// Bootstrap admin（§5 Bootstrap 五条规则，migrate 之后、listen 之前）。
// live admin = system_role='admin' AND account_status='enabled' AND deleted_at IS NULL。
// 日志只写 bootstrap=created|skipped|reset|refused，不写密码；refused 时抛错，进程退出码非零。
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "./client.js";
import { users } from "./schema.js";
import { deleteSessionsByUserId } from "../modules/auth/session-repo.js";
import { hashPassword } from "../modules/auth/service.js";

export type BootstrapResult = "created" | "skipped" | "reset" | "refused";

export class BootstrapRefusedError extends Error {
  constructor(reason: string) {
    super(`bootstrap refused: ${reason}`);
    this.name = "BootstrapRefusedError";
  }
}

export interface BootstrapEnv {
  ADMIN_USERNAME?: string | undefined;
  ADMIN_PASSWORD?: string | undefined;
  ADMIN_BOOTSTRAP_RESET_PASSWORD: boolean;
}

export interface BootstrapOptions {
  /** 时钟注入（epoch 秒），测试可替换 */
  now?: () => number;
  /** 只接收 `bootstrap=created|skipped|reset|refused`；默认 console.log */
  log?: (message: string) => void;
}

function findLiveAdmin(db: Db): { id: number } | undefined {
  return db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.systemRole, "admin"),
        eq(users.accountStatus, "enabled"),
        isNull(users.deletedAt),
      ),
    )
    .get();
}

function findLiveUserByUsername(db: Db, username: string) {
  return db
    .select()
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .get();
}

export async function bootstrapAdmin(
  db: Db,
  env: BootstrapEnv,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? ((m: string) => console.log(m));

  const finish = (result: Exclude<BootstrapResult, "refused">): BootstrapResult => {
    log(`bootstrap=${result}`);
    return result;
  };
  const refuse = (reason: string): never => {
    log("bootstrap=refused");
    throw new BootstrapRefusedError(reason);
  };

  // 规则 1：reset flag 且无密码 → 拒绝启动
  if (env.ADMIN_BOOTSTRAP_RESET_PASSWORD && !env.ADMIN_PASSWORD) {
    return refuse(
      "ADMIN_BOOTSTRAP_RESET_PASSWORD=true 但未设置 ADMIN_PASSWORD（不要把 reset 长期留在 unit 文件）",
    );
  }

  const liveAdmin = findLiveAdmin(db);
  if (liveAdmin) {
    // 规则 2：已有 live admin
    if (!env.ADMIN_BOOTSTRAP_RESET_PASSWORD) {
      return finish("skipped"); // 不要求 ADMIN_PASSWORD
    }
    // reset：必须有明确对象
    const target = env.ADMIN_USERNAME
      ? findLiveUserByUsername(db, env.ADMIN_USERNAME)
      : undefined;
    if (!target) return refuse("reset 需要 ADMIN_USERNAME 指定一个已存在且未删除的用户");
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD!);
    db.update(users)
      .set({ passwordHash, updatedAt: now() })
      .where(eq(users.id, target.id))
      .run();
    deleteSessionsByUserId(db, target.id); // reset 后踢掉其全部 session
    return finish("reset");
  }

  // 规则 3：零 live admin，凭据齐全 → upsert（自锁恢复）；缺任一 → 拒绝启动
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    const passwordHash = await hashPassword(env.ADMIN_PASSWORD);
    const existing = findLiveUserByUsername(db, env.ADMIN_USERNAME);
    if (existing) {
      // 把已有行拉回 enabled admin
      db.update(users)
        .set({
          passwordHash,
          systemRole: "admin",
          accountStatus: "enabled",
          updatedAt: now(),
        })
        .where(eq(users.id, existing.id))
        .run();
    } else {
      // 规则 4：INSERT 默认值
      const t = now();
      db.insert(users)
        .values({
          username: env.ADMIN_USERNAME,
          passwordHash,
          nickname: "管理员",
          jobTitle: "other",
          systemRole: "admin",
          employmentStatus: "employed",
          accountStatus: "enabled",
          createdBy: null,
          createdAt: t,
          updatedAt: t,
        })
        .run();
    }
    return finish("created");
  }
  return refuse("无 live admin：请设置 ADMIN_USERNAME 与 ADMIN_PASSWORD");
}
