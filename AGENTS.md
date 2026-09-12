# AGENTS.md — gb-crm

闪光团队客户信息管理系统（品牌文案 **「女商 私域运营管理端」**）。内网单进程：Vite + React 管理端 + Fastify REST + SQLite。

本文件是给编码代理的**工作契约**：工程结构、命令、硬性约定。功能细节与全部编号决策（K1–K60）查 `docs/design.md` 的 Key Decisions 表——那是唯一真相源，本文件不复述。需求原文 `docs/core.md`，视觉 `docs/style.md`，Agent 签发与 Skill 用法 `docs/dev.md`，远程备份（Cloudflare R2）指南 `docs/remote-backup.md`。

## 工程结构

npm workspaces monorepo。Node **24**（`.nvmrc`）。包管理器是 **npm**，不要引入 pnpm / yarn。

```
gb-crm/
  apps/web/          @gb-crm/web    Vite + React 管理端（中文 UI）
  apps/api/          @gb-crm/api    Fastify + Drizzle + better-sqlite3
  packages/shared/   @gb-crm/shared Zod schema、枚举、labels、can() ACL、PAGE_REGISTRY
  skills/gb-crm/     Agent skill 源目录（软链 .agents/skills/gb-crm 为项目级 skill）
  e2e/               Playwright 冒烟（不进 npm test，不挡合并）
  docs/              core.md / design.md / dev.md / style.md / remote-backup.md
  Dockerfile + docker-compose.yml
```

`@gb-crm/shared` 的 `exports` 指向 `src/index.ts`（无构建产物）。API 用 `tsx` + **NodeNext**；web 用 Vite。根 `tsconfig.base.json` **不要**设 `moduleResolution: bundler`。v1 **不抽** `packages/ui`。视觉 token 在 `apps/web/src/styles/tokens.css`。

### API 分层（每个资源三层，禁止跨层）

`apps/api/src/modules/<resource>/`

| 层 | 文件 | 职责 |
| --- | --- | --- |
| routes | `routes.ts` | Zod 解析、`requireCan`、HTTP 映射。**不写 SQL** |
| service | `service.ts` | 业务规则、PATCH 内核、事务 |
| repo | `repo.ts` | SQL / Drizzle |
| assemble | `assemble.ts` | 行 → JSON（展开 live 关联，INNER 未删除） |

例外：`modules/agent/routes.ts` 单文件模块（K35 Agent SQL 端点），直接用 `db.$client` 原生 better-sqlite3，不走三层。

模块速览（行为细节 = design.md 对应 K 行）：

- `tags`（K45/K58）词表，分域 `domain=customer|material`，admin 写、其余只读；维护入口「业务设置」`/business-settings`
- `system`（K46/K50/K53/K57）通用 `system_configs` 表按 `code` 行扩展，不建表：`llm`（LLM 配置，GET 掩码/PATCH，admin）、`pageAccess`（角色→页面权限，只在 can() 允许集内收缩）、`s3`/`materialsS3`（备份/资料对象存储，各自 `GET/PATCH + POST .../test`，secret 只回掩码、enabled=true 时四要素齐备否则 422）、`commissionDefault`（K56 分成默认方案）、`copywritingPrompts`（K60+ 文案工作台 generate/review/audit system prompt 覆盖值，GET 生效值缺省内置女商红线默认（prompts.ts 为最后真相）、PATCH null/空串恢复默认，admin）
- `jobs`（K51/K52）后台任务 `background_jobs` + 定时调度 `job_schedules`；执行器 `runner.ts` 进程内**串行**消费 queued（`pumpOnce()` 测试 / `start()` 生产），调度器 CAS 推进到期 cron（`lib/cron.ts` 零依赖，按进程本地时区——生产容器 `TZ=Asia/Shanghai`）；任务类型 `registry.ts` 注册（未知 422、params 创建+执行双侧 Zod 校验、创建预检 LLM 就绪 422）
- `materials`（K54/K57/K58）交付资料：可空挂交付单（孤儿允许）+ 客户 M2M；文本类全文入 `content`、媒体类只存 url、file 走 materialsS3 multipart；FTS5 trigram 虚表（≥3 字符 MATCH、<3 回退 LIKE；FTS 不入 Drizzle schema，repo 用 `db.$client`）
- `customer-records`（K55）客户维护记录嵌套路由，纯时间线，**不新增 customers.status 列**；新建 follow_up/lead 顺带 bump `customers.last_followed_at`
- `deal-commissions` + `payout-batches`（K56 v2/K59）成交分成三级模型（税后基数→总比例→内部分配）+ payout + 结算批次；每人每期金额**不物化**，shared `splitPayoutAmount` 推导
- `copywriting`（K60）文案工作台：`copy_templates` 模板词表（六维度，live 唯一 `(dimension,name)`，admin/operator 写、assistant 只读；`0031_copy_templates_seed.sql` 种 21 条六维度模板——数字不写死/没把握标「待核」，表空才插不覆盖 UI 维护）+ `copy_items` 已存文案（title 必填、LLM 生成预填）；generate（→`{title,content}`）/ review（逆向检查：第二轮 LLM 审修，修订稿为产出）/ audit 三个 LLM 端点只收最终文本快照、不解析模板 id；system prompt 统一走 `system_configs` code='copywritingPrompts'（内置默认 prompts.ts 不可修改，请求 `systemPrompt`/`reviewPrompt` 可单次覆盖）

公共能力：

- `src/lib/` — `patch-kernel.ts`（PATCH 标量内核：键存在才 SET）、`pagination.ts`、`fuzzy.ts`、`audit.ts`、`excel-date.ts`、`llm.ts`、`s3.ts`（SigV4 零依赖，`llmFetch`/`s3Fetch` 可注入 mock）
- `src/plugins/` — cookie、session-auth、rbac、error-handler、static-spa
- `src/db/` — client（PRAGMA）、schema、migrate、bootstrap-admin。`drizzle/*.sql` 是 migration 真相，`schema.ts` 镜像 SQL

测试用 `buildApp()` + `app.inject()`，不 listen。生产入口 `src/index.ts`：parseEnv → 建库 → migrate → bootstrap → listen。

### Web

- 路由：`/login` `/my/customers` `/my/deals` `/customers` `/customers/:id`（总览）`/channels` `/products` `/deals` `/deals/commissions` `/deals/payout-batches(/:id)` `/deliveries` `/deliveries/:id`（含 `/circle` `/gantt` `/matrix`）`/delivery-types` `/materials` `/materials/:id/edit`（文本类全文）`/copywriting`（文案工作台：生成与审计（六维度纵向整行平铺 + 自动逆向检查开关 + 结果区标题/正文可编辑行内保存）/已保存文案/模板管理/提示词配置 admin——三类 system prompt 覆盖值）`/users` `/settings`（tab：LLM/角色权限/远程备份/资料存储/后台任务/定时任务）`/tokens`（授权管理，admin）`/business-settings`（默认页）
- 页面权限唯一由 `packages/shared/src/pages.ts` 的 `PAGE_REGISTRY` + `/auth/me.pages` 驱动（安全层 can() ∩ 配置允许集）；`PageGuard` 把无权路由重定向到该角色第一张可看菜单页；详情页跟随父页面。**改菜单/新增页只改注册表**，不要在 Sidebar/App 手写显隐；面包屑由 `layout/breadcrumb.ts` 沿注册表推导
- 表格 `components/DataGrid/`（双击编辑 + 行内 PATCH 队列）；列表容器 `.data-grid-scroll` 竖滚 + 表头吸顶；`selectable` + 受控 `selectedIds` 行多选批量操作；分页含「跳转到第几页」；`/` 聚焦搜索，`Cmd/Ctrl+K` 客户快速搜索（`CommandPalette`）；侧栏分组可折叠（localStorage）
- 图标统一 `@phosphor-icons/react`，**禁止字符 glyph 当控件图标**；小图标 `weight="bold"` + `aria-hidden`
- 列定义 `src/columns/`；列表页 `src/pages/` + `useResourceList.ts`
- 开发 Vite `:5173`，`server.proxy."/api"` → `:3001`；生产 Fastify 托管 `apps/web/dist`，非 `/api/*` 且非静态文件的 GET → `index.html`

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
- PATCH 内核：JSON **键存在** → SET（`null` 清空可空列）；**键缺席** → 不动。关系数组同理：缺席不动，`[]` 清空（`socialAccounts`、`sourceChannelIds`、`tagIds` 同规则）。客户归属人 `ownerId` 单值（K39）：缺席不动、`null` 清空；社交账号 `socialAccounts` 值数组 `{ platform, account }`（K41）。行级 OCC 用 `updatedAt`；客户端每行一条队列、串行、每次带上一次 200 的 `updatedAt`。
- 删除 = 软删 `deleted_at`。v1 **无**回收站、**无**硬删。软删时 **不剥** join 行。GET 展开只 INNER **未删除** 的用户/渠道。
- SQLite PRAGMA（WAL / busy_timeout=5000 / foreign_keys=ON）只在 `db/client.ts` 每条连接上执行，**不写进 migration**。库文件创建后 `chmod 600`。备份只用 `.backup`，禁止 `cp` 热库。
- handler 是同步 SQLite，会堵住事件循环。v1 不上 worker pool / Redis / Postgres。

### 认证与权限

- 服务端 session + 签名 httpOnly cookie（HMAC = `SESSION_SECRET`）。不做 JWT、不做飞书登录。密码 argon2id；登录要求 `system_role ∈ {admin, operator, assistant}`。
- Session 最多每 30 分钟 touch 一次（或剩余 idle < 11h）。禁用账户立即删 session **并撤销 PAT**。
- **Agent PAT（K35）与 cookie 并行**：`Authorization: Bearer`，有 Bearer 不回落 cookie。数据访问走单一自由 SQL 端点 `POST /api/v1/agent/sql`（仅 Bearer，cookie 403）：better-sqlite3 `stmt.readonly` 判读写——只读语句任意 scope/角色放行（含渠道密钥列）；写语句必须 write scope + admin/operator；DDL（CREATE/ALTER/DROP）对任何令牌一律 403；单语句；读上限 1000 行截断。
- **PAT 治理**（`/tokens` 授权管理，admin）：`GET /api/v1/auth/tokens/admin`（分页 + `status=active|revoked|expired`/`scope`/`userId` 过滤）+ `DELETE /api/v1/auth/tokens/admin/:id`（吊销任意），ACL `auth.list`/`auth.revoke` 仅 admin；吊销置 `revoked_at`+`revoked_by`，行不删、历史可查。
- **Skill 下发改装（渠道 A，内网免 GitHub）**：一条命令 `curl -fsSL http://<host>/agent/skill/gb-crm/install.sh | sh`（Windows 用 `install.ps1`），装到项目级 `./.agents/skills`（否则 `~/.agents/skills`）+ codex/claude 全局技能目录，再引导 `login.sh`/`login.ps1` 授权（`~/.gb-crm/credentials.json`）；**更新 = 重跑同一条命令**（现取安装器覆盖 `SKILL.md`/`gb-crm.py`）。版本号单一真相源 = `skills/gb-crm/SKILL.md` front-matter `version`；技能源 = 仓库 `skills/gb-crm`（生产容器已 `COPY skills ./skills`）；`GB_CRM_FORCE_LOGIN=1` 强制重签、`GB_CRM_SKIP_LOGIN=1` 只装文件。Skill 不含密钥。
- **扮演用户（K49）**：admin 可把当前 cookie session 切到任一可加载用户（测「我的运营」）。单层不可嵌套，`sessions.impersonated_by` 记录原身份；`/api/v1/auth/impersonate/{targets,:id,stop}` 仅 cookie（Bearer 403），start 需 `auth.impersonate`，stop 只要求会话处于扮演中；禁止扮演自己，目标须未软删/enabled/有角色；`/auth/me` 带 `impersonatedBy`；Web 用户菜单「切换身份」，扮演中显徽标 + 「退出扮演」。
- 登录限流 10 次/分钟/IP；仅 `TRUST_PROXY=true` 时才信 `X-Forwarded-For`。
- 权限唯一来源：`packages/shared` 的 `can(role, resource, action)`。缺席 = deny。`role===null` → false。路由用 `requireCan`，不要在 service 再抄一套角色判断。
- **无行级 ACL**（没有「只看我的客户」的权限收紧；「我的运营」只是 ownerId 固定过滤的列表页，不限制数据可见性）。
- Bootstrap：零 live admin 时要 `ADMIN_USERNAME` + `ADMIN_PASSWORD`。已有 live admin 可省略密码。`ADMIN_BOOTSTRAP_RESET_PASSWORD=true` 且无密码 → **拒绝启动**。

角色能力摘要：

| | admin | operator | assistant |
| --- | --- | --- | --- |
| users 写 / 设角色 / 设他人密码 | ✓ | list/read only | ✗ |
| channels 全套含密钥字段 | ✓ | ✓ | 可改普通字段；密钥 GET 为 null，不可 PATCH |
| products | ✓ | ✓ | list/read only |
| customers.create / updateOwners（ownerId 键，K39 单值） | ✓ | ✓ | ✗（仍可 PATCH 其它标量） |
| deals（K42） | ✓ | ✓ | list/read only |
| deliveries（K44） | ✓ | ✓ | list/read only |
| tags 词表（写=增删改词表） | ✓ | list/read only | list/read only |
| materials（K54） | ✓ | ✓ | list/read only |
| customerRecords（K55） | ✓ | ✓ | list/read only |
| dealCommissions（K56，配置=update；payout 同） | ✓ | ✓ | list/read only |
| copywriting（K60，含模板维护与生成/审计） | ✓ | ✓ | list/read only |
| system 配置（K46） | ✓ | ✗ | ✗ |
| jobs 后台任务（创建/查看/取消自己的） | ✓（+cancelAny 可取消他人） | ✓ | ✓ |

渠道密钥字段：`accountId` / `registerPhone` / `registrant` / `realNamePerson` / `loginDevice`。

成员字段拆分，不要合并：`job_title`（岗位展示）× `system_role`（登录权限）× `employment_status`（在职）× `account_status`（闸门）。无登录成员仍进 `users`。离职不自动改闸门。

### UI / 视觉

- 主底永远冷灰 `#F1F1EF`，禁整页铺玄黑。冷漆红 `#CE1432` 只点睛（面积 ≤5%）。玄黑底上的字用奶白 `#EDEAE3`，别用纯白。
- 表格：**双击**进入编辑（单击只选中）；文本 debounce 300ms；Tab/Enter **先 flush 再导航**。不是完整 spreadsheet，不要上 AG Grid Enterprise。
- 列表页：`q` + pageSize 25/50/100 + 至多一个类型/状态下拉。API 上的 `ownerId`/`channelId` 过滤可以有，**UI 不做**（例外：「我的运营」固定 ownerId=当前用户不加下拉；客户页一个标签下拉——`useResourceList` 的 `secondaryFilterKey`，仅客户页用；成交页 `/deals` 与 `/my/deals` 用多维筛选条 `DealFilterBar`）。

### 环境变量

见 `.env.example`。必填：`SESSION_SECRET` ≥ 32。零 live admin 时还要 `ADMIN_*`。`.env` / `.env.production` / `*.sqlite*` / `data/` 永不提交。

本地 API `dev` 脚本会 `--env-file=../../.env`。生产由 compose `env_file` 注入，不要把 `.env` 打进镜像。

可选空字符串不要写进 `.env`（`FOO=` 会变成 `""`，Zod `optional` + `min(1)` 会炸）。需要时再填。

## 主要功能（v1）

四张主数据（users/channels/products/customers）的权限化 CRUD + 成交 + 交付 + 资料/分成/文案等扩展模块，Excel 式就地编辑。各模块完整行为见 design.md 对应 K 行，此处只列入口与跨模块硬规则。活动交付记录 / 内容资产 / 调休流水是 Phase 2，不要在 v1 加。

1. **登录与会话**：bootstrap 管理员；改自己密码；admin 给他人设密码。
2. **团队成员 `/users`**：账户/昵称/真实姓名/电话/微信/岗位/系统角色/雇佣/账户状态。仅 admin 可写。
3. **渠道资产 `/channels`**：内容/对客渠道账号，负责人 M2M；assistant 看不到登录资产。
4. **产品目录 `/products`**：类型/状态/是否套餐/价格（分）。
5. **客户信息 `/customers`**（K39/K41）：分页/模糊搜索/来源渠道/归属人单值/社交账号独立表（列表与导出不展示）；导出 `GET /customers/export.xlsx` 复用列表 WHERE、不分页。**所有 xlsx 导出日期单元格必须走 `lib/excel-date.ts` 的 `excelDate`/`excelDayText`**（伪 UTC Date 对齐 Asia/Shanghai 墙钟），禁止 `new Date(ts)` 直进单元格。
6. **成交记录 `/deals`**（K42）：客户 FK 必填、负责人可空、`deal_date` 新建必填、`delivery_date` 可空；assistant 只读。列表筛选 `DealFilterBar` 参数：`customerId`/`ownerId`/`customerOwnerId`/`startDate`+`endDate`/`deliveryStartDate`+`deliveryEndDate`/`deliveryStatus=empty|notEmpty`——命名与成交分成列表 flat 参数一致。
7. **客户画像**（K45–K51）：标签词表 + 客户 M2M + AI 单条/批量打标（批量走后台任务）+ 总览页 `/customers/:id`（`GET /customers/:id/overview`）；AI 推断 `industry` 总是覆盖写回。
8. **交付管理**（K44）：交付单/交付类型/交付项（项目维度 + 客户维度打勾）；圈子类（kind=circle）有专项工作台 `/deliveries/:id/circle`（+ 甘特/矩阵页）。
9. **我的运营**：`/my/customers`（ownerId=我）`/my/deals`（负责人=我）；复用列表页固定过滤，不提供「新增」。
10. 每张业务表有 `created_at` / `updated_at` / `created_by` / `updated_by`。
11. **Agent 令牌**：见「认证与权限」。
12. **资料专区 `/materials`**（K54/K57/K58）：咨询场次资料库，FTS5 搜索，文本类全文编辑页 `/materials/:id/edit`；assistant 只读；历史补录走 Agent SQL 端点，不做导入功能。
13. **客户维护记录**（K55）：总览页时间线区块；状态变化用 `status_change` 记录 + content 表达，**不加 customers.status 列**。
14. **文案工作台 `/copywriting`**（K60）：六维度提示词 + LLM 生成/审计 + 保存备查。

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
