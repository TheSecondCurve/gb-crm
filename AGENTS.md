# AGENTS.md — gb-crm

闪光团队客户信息管理系统（品牌文案锁定 **「闪光 · 客户运营」**，禁止「女商」）。内网单进程：Vite + React 管理端 + Fastify REST + SQLite。

完整架构与编号决策见 `docs/design.md`（K1–K35）。需求原文 `docs/core.md`，视觉 `docs/style.md`，Agent 签发与 Skill 用法 `docs/dev.md`。本文件是给编码代理的工作契约：改代码前先对照这里，再对照 design。

## 工程结构

npm workspaces monorepo。Node **24**（`.nvmrc`）。包管理器是 **npm**，不要引入 pnpm / yarn。

```
gb-crm/
  apps/web/          @gb-crm/web    Vite + React 管理端（中文 UI）
  apps/api/          @gb-crm/api    Fastify + Drizzle + better-sqlite3
  packages/shared/   @gb-crm/shared Zod schema、枚举、labels、can() ACL
  skills/gb-crm/     Agent skill（K35 源目录）；经软链 .agents/skills/gb-crm 安装为本项目范围 skill
  e2e/               Playwright 冒烟（不进 npm test，不挡合并）
  docs/              core.md / design.md / dev.md / style.md
  Dockerfile + docker-compose.yml
```

`@gb-crm/shared` 的 `exports` 指向 `src/index.ts`（无构建产物）。API 用 `tsx` + **NodeNext**；web 用 Vite。根 `tsconfig.base.json` **不要**设 `moduleResolution: bundler`。

v1 **不抽** `packages/ui`。视觉 token 在 `apps/web/src/styles/tokens.css`。

### API 分层（每个资源三层，禁止跨层）

`apps/api/src/modules/<resource>/`

| 层 | 文件 | 职责 |
| --- | --- | --- |
| routes | `routes.ts` | Zod 解析、`requireCan`、HTTP 映射。**不写 SQL** |
| service | `service.ts` | 业务规则、PATCH 内核、事务 |
| repo | `repo.ts` | SQL / Drizzle |
| assemble | `assemble.ts` | 行 → JSON（展开 live 关联，INNER 未删除） |

例外：`modules/agent/routes.ts` 是单文件模块（K35 Agent SQL 端点），直接用 `db.$client` 原生 better-sqlite3，不走三层。

公共能力：

- `src/lib/patch-kernel.ts` — PATCH 标量内核（键存在才 SET）
- `src/lib/pagination.ts` / `fuzzy.ts` / `audit.ts`
- `src/plugins/` — cookie、session-auth、rbac、error-handler、static-spa
- `src/db/` — client（PRAGMA）、schema、migrate、bootstrap-admin
- `drizzle/0000_init.sql` 是主数据 migration 真相；`0001_api_tokens.sql` 是 PAT（K35）；`schema.ts` 镜像 SQL

测试用 `buildApp()` + `app.inject()`，不 listen。生产入口 `src/index.ts`：parseEnv → 建库 → migrate → bootstrap → listen。

### Web

- 路由：`/login` `/customers` `/channels` `/products` `/users`（默认进客户）
- 表格：`components/DataGrid/`（双击编辑 + 行内 PATCH 队列）
- 列定义：`src/columns/`；列表页：`src/pages/` + `useResourceList.ts`
- 开发：Vite `:5173`，`server.proxy."/api"` → `:3001`
- 生产：Fastify 托管 `apps/web/dist`；非 `/api/*` 且非静态文件的 GET → `index.html`

## 常用命令

```bash
cp .env.example .env          # 填 SESSION_SECRET（≥32）与首次 ADMIN_*
npm install
npm run db:migrate
npm run dev                   # api :3001 + web :5173

npm run lint
npm run typecheck
npm test                      # 全部 workspace vitest；api 带 v8 覆盖率门禁
npm run e2e                   # 先 build web，再生产模式 api + Playwright（不挡合并）
```

macOS 编译 `better-sqlite3` 需要 Xcode CLT 与 Python 3。原生模块 install 脚本已在根 `package.json` 的 `allowScripts` 放行（argon2 / esbuild / better-sqlite3）。

Workspace 依赖写法：`"@gb-crm/shared": "*"`（npm 不支持 `workspace:*`）。`dev` 用 `concurrently` 并行起 api 与 web。

## 开发标准

### Git

- `origin/dev` 与 `origin/main` **已存在**，禁止再创建 `dev`。
- 功能分支一律从 `dev` 拉：`feat/<topic>` 或 `fix/<topic>`。
- PR **base = `dev`**，CI 绿才合入；合入后删除远程功能分支。
- 禁止从 `main` 拉功能分支；禁止直推 `main` / `dev`。
- 发布：`dev` 稳定后 PR `dev` → `main`，建议 merge commit。

### TDD 与测试

- **先写失败测试再写实现**，实现与测试同一 PR。
- API：Vitest + 临时 sqlite + `inject()`。覆盖率门禁覆盖 `apps/api/src/{modules,plugins,lib,db}/**`（不含 `schema.ts`）合计 **≥ 80%**（statements/branches/functions/lines）。
- 必须覆盖：无 `systemRole` 登录 401；reset flag 无密码拒启；有 live admin 时无 `ADMIN_PASSWORD` 仍可启动；`can()` 矩阵相关 403。
- Web：Testing Library。DataGrid 必须覆盖 Tab 两格无 409、unmount flush、pageSize 切换。
- Playwright 在 `e2e/`，**不进** `npm test`，CI `continue-on-error`，不挡合并。
- `can()` 每一格有单测（`packages/shared/test/acl.test.ts`）。枚举 labels 必须与 Zod enum 双向对齐，禁止节选。

### API 约定

- 前缀 `/api/v1`。成功列表：`{ data, meta: { page, pageSize, total } }`。单资源：`{ data }`。
- 错误：`{ error: { code, message, details? } }`，`message` 中文可直接 Toast。校验失败 422 `VALIDATION`。409 `CONFLICT` 时带当前完整行。
- JSON **一律 camelCase**（含 `sort=updatedAt`）。禁止 snake_case query 混 camelCase body。
- 时间戳：**epoch 毫秒 UTC**。Cookie `maxAge` 例外（秒）。
- 金额：`priceCents` 整数贯穿 DB 与 JSON；UI 展示元。禁止 `yuan * 100` 不 round 就写入。
- PATCH 内核：JSON **键存在** → SET（`null` 清空可空列）；**键缺席** → 不动。关系数组同理：缺席不动，`[]` 清空。客户归属人 `ownerId` 单值（K39）：缺席不动、`null` 清空；社交账号 `socialAccounts` 值数组 `{ platform, account }`（K41）。行级 OCC 用 `updatedAt`；客户端每行一条队列、串行、每次带上一次 200 的 `updatedAt`。
- 删除 = 软删 `deleted_at`。v1 **无**回收站、**无**硬删。软删时 **不剥** join 行。GET 展开只 INNER **未删除** 的用户/渠道。
- SQLite PRAGMA（WAL / busy_timeout=5000 / foreign_keys=ON）只在 `db/client.ts` 每条连接上执行，**不写进 migration**。库文件创建后 `chmod 600`。备份只用 `.backup`，禁止 `cp` 热库。
- handler 是同步 SQLite，会堵住事件循环。v1 不上 worker pool / Redis / Postgres。

### 认证与权限

- 服务端 session + 签名 httpOnly cookie（HMAC = `SESSION_SECRET`）。不做 JWT、不做飞书登录。
- 密码 argon2id。登录还要求 `system_role ∈ {admin, operator, assistant}`。
- Session 最多每 30 分钟 touch 一次（或剩余 idle < 11h）。禁用账户立即删 session **并撤销 PAT**。
- Agent PAT（K35）与 cookie **并行**：`Authorization: Bearer`；有 Bearer 不回落 cookie。签发：`curl -fsSL http://<host>/agent/login.sh | sh` → `~/.gb-crm/credentials.json`。REST 资源路由 `read`/`write` ∩ `can()`。Skill 在 `skills/gb-crm/`，**不含**密钥。Agent 数据访问走单一自由 SQL 端点 `POST /api/v1/agent/sql`（仅 Bearer PAT，cookie 403）：better-sqlite3 `stmt.readonly` 判读写——只读语句任意 scope/角色放行（含渠道密钥列），写语句必须 write scope + admin；单语句；读上限 1000 行截断。
- 登录限流 10 次/分钟/IP；仅 `TRUST_PROXY=true` 时才信 `X-Forwarded-For`。
- 权限唯一来源：`packages/shared` 的 `can(role, resource, action)`。缺席 = deny。`role===null` → false。路由用 `requireCan`，不要在 service 再抄一套角色判断。
- **无行级 ACL**（没有「只看我的客户」）。
- Bootstrap：零 live admin 时要 `ADMIN_USERNAME` + `ADMIN_PASSWORD`。已有 live admin 可省略密码。`ADMIN_BOOTSTRAP_RESET_PASSWORD=true` 且无密码 → **拒绝启动**。

角色能力摘要：

| | admin | operator | assistant |
| --- | --- | --- | --- |
| users 写 / 设角色 / 设他人密码 | ✓ | list/read only | ✗ |
| channels 全套含密钥字段 | ✓ | ✓ | 可改普通字段；密钥 GET 为 null，不可 PATCH |
| products | ✓ | ✓ | list/read only |
| customers.create / updateOwners（ownerId 键，K39 单值） | ✓ | ✓ | ✗（仍可 PATCH 其它标量） |
| deals（成交表，K42） | ✓ | ✓ | list/read only |
| deliverables（交付项 + 动作打勾，K43） | ✓ | ✓ | list/read only |

渠道密钥字段：`accountId` / `registerPhone` / `registrant` / `realNamePerson` / `loginDevice`。

成员字段拆分，不要合并：`job_title`（岗位展示）× `system_role`（登录权限）× `employment_status`（在职）× `account_status`（闸门）。无登录成员仍进 `users`。离职不自动改闸门。

### UI / 视觉

- 主底永远冷灰 `#F1F1EF`，禁整页铺玄黑。冷漆红 `#CE1432` 只点睛（面积 ≤5%）。玄黑底上的字用奶白 `#EDEAE3`，别用纯白。
- 表格：**双击**进入编辑（单击只选中）；文本 debounce 300ms；Tab/Enter **先 flush 再导航**。不是完整 spreadsheet，不要上 AG Grid Enterprise。
- 列表页：`q` + pageSize 25/50/100 + 至多一个类型/状态下拉。API 上的 `ownerId`/`channelId` 过滤可以有，**UI 不做**。

### 环境变量

见 `.env.example`。必填：`SESSION_SECRET` ≥ 32。零 live admin 时还要 `ADMIN_*`。`.env` / `.env.production` / `*.sqlite*` / `data/` 永不提交。

本地 API `dev` 脚本会 `--env-file=../../.env`。生产由 compose `env_file` 注入，不要把 `.env` 打进镜像。

可选空字符串不要写进 `.env`（`FOO=` 会变成 `""`，Zod `optional` + `min(1)` 会炸）。需要时再填。

## 主要功能（v1）

四张主数据的权限化 CRUD + 成交表（K42）+ 交付项与动作打勾（K43），Excel 式就地编辑。活动交付记录 / 内容资产 / 调休流水是 Phase 2，不要在 v1 加。

1. **登录与会话**：bootstrap 管理员；改自己密码；管理员给他人设密码。
2. **团队成员 `/users`**：账户、昵称、真实姓名、电话、微信、岗位、系统角色、雇佣状态、账户状态。仅 admin 可写。
3. **渠道资产 `/channels`**：内容/对客渠道账号；关联负责人（M2M）；助手看不到登录资产。
4. **产品目录 `/products`**：类型/状态/是否套餐/价格（分）+ 默认交付动作（`default_tasks` 多行文本，K43 模板）。
5. **客户信息 `/customers`**：分页、模糊搜索、来源渠道、归属人（单值 `owner_id`，K39）、社交账号独立表（`customer_social_accounts`，K41，列表页/导出不展示）；预留可空唯一 `wechat_openid`（不接小程序）。导出 Excel：`GET /api/v1/customers/export.xlsx`（exceljs 服务端生成，复用列表同一 WHERE，跟随 q/类型筛选，不分页）。
6. **成交记录 `/deals`**（K42）：客户（单值 FK 必填）、意向产品、负责人（单值 FK 可空）、阶段（赠送/已付款/退款/已关闭）、订单号、交付日期、支付信息备注；客户城市只读列。assistant 只读。
7. **交付管理 `/deliverables`**（K43）：交付项挂成交（可拆多条），状态（未交付/交付中/已交付/已取消）、计划/实际交付日期、有效期、交付说明、交付物链接；动作打勾清单（`delivery_tasks`）——产品默认动作模板预填 + 单独增删改，打勾记完成人/时间。assistant 只读。
8. 每张业务表有 `created_at` / `updated_at` / `created_by` / `updated_by`。
9. **Agent 令牌**：已有用户本机签发 PAT，skill 走单一 SQL 端点 `/api/v1/agent/sql`（K35）。

飞书字段已全部移除（四张主表均无任何 `feishu_*` 列）。**v1 不做飞书 / CSV 导入**，不要加回 `import-feishu` 或 `FEISHU_*` 环境变量。主数据在管理端维护。

## 明确不要做

- 飞书双向同步、飞书 OAuth、飞书机器人、飞书/CSV 导入脚本
- JWT、GraphQL、微服务、Kafka、Redis、对象存储、Postgres（Agent SQL 端点是 K35 已拍板的唯一例外，规则见上）
- 微信小程序 / 支付（只留 `wechat_openid` 列）
- 移动 App、i18n、暗色主题
- 行级「只看我的客户」
- 硬删除、回收站
- 公网暴露与公网级威胁加固（内网 Docker + 可选 Caddy HTTPS）
- 与女商运营管理端同仓同应用
- 磁盘 at-rest 加密（依赖 OS / 文件权限 600）

## 生产

内网 Docker 单进程（K32）。SQLite **只在 named volume**，不进镜像。推荐前面放 Caddy：`COOKIE_SECURE=true` + `TRUST_PROXY=true`。`HOST` 非 loopback 且未 Secure 时进程 **只 warn 不拒启**。容器非 root（`node`）。备份唯一配方：`sqlite3 "$DATABASE_PATH" ".backup …"`。
