# gb-crm — 女商 私域运营管理端

闪光团队客户信息管理系统。npm workspaces + TypeScript monorepo：

- `apps/web` — Vite + React 管理端（中文 UI）
- `apps/api` — Fastify + Drizzle + SQLite（WAL）REST API
- `packages/shared` — 两端共享的 Zod schema、枚举与 ACL

完整架构与实现约束见 `docs/design.md`。

## 本地开发

环境：Node 24（见 `.nvmrc`）+ npm（随 Node 附带）。

```bash
cp .env.example .env          # 填 SESSION_SECRET（≥32 字符）与 ADMIN_*
npm install
npm run db:migrate
npm run dev                   # api :3001 + web :5173（Vite 代理 /api → :3001）
```

常用命令：

```bash
npm run lint        # eslint（全部包）
npm run typecheck   # tsc --noEmit（全部包）
npm test            # vitest（全部包；api 带 v8 覆盖率门禁）
```

### macOS 编译 better-sqlite3

`better-sqlite3` 需要本地编译工具链：Xcode Command Line Tools 与 Python 3。

```bash
xcode-select --install
```

CI 使用官方 Node 24 环境，无需额外处理。

## Agent 令牌（本机 skill，无需克隆仓库）

已部署的 CRM 托管登录脚本。同事电脑只要能访问内网 API：

```bash
curl -fsSL http://<crm-host>/agent/login.sh | sh
```

交互输入用户名、密码、范围（`read` / `write`），写入 `~/.gb-crm/credentials.json`（目录 `700`、文件 `600`）。之后 skill 读这个文件，请求头：

```
Authorization: Bearer gbcrm_ro_…
```

非交互（CI / 无 TTY）：

```bash
GB_CRM_USERNAME=alice GB_CRM_PASSWORD='***' GB_CRM_SCOPE=read \
  curl -fsSL http://<crm-host>/agent/login.sh | sh
```

- **read**：只能 GET（可撤销自己的令牌）。
- **write**：走现有 REST 的写接口，仍受该用户 `can()` 角色约束。
- 明文 token 只在签发接口出现一次；管理端列表只显示 prefix。禁用账户会撤销其令牌。

Agent skill 包在仓库 `skills/gb-crm/`（备用；拷到本机 skill 目录即可用）。脚本读上述凭证文件，不把 token 写进 skill。完整设计 `docs/design.md` K35，命令与拷贝步骤 `docs/dev.md`。

## Git 工作流

- `origin/dev` 与 `origin/main` **均已存在**，禁止再创建 `dev`。
- 功能分支 `feat/<topic>`（修复 `fix/<topic>`）一律从 `dev` 拉出：

  ```bash
  git fetch origin && git checkout dev && git pull
  git checkout -b feat/<topic> dev
  ```

- PR **base = `dev`**，CI 绿才合入；合入后删除远程功能分支。
- 禁止从 `main` 拉功能分支；禁止直推 `main` / `dev`。
- 发布：`dev` 稳定后开 PR `dev` → `main`，建议用 **merge commit** 保留 feat 历史。

## 生产部署

内网 Docker 单进程（设计 K32 / §13）：同一 Fastify 进程托管 `/api` 与 `apps/web/dist`，
非 `/api/*` 且非静态文件的 GET 回 `index.html`（SPA fallback，K20）。

```bash
cp .env.production.example .env.production   # 填 SESSION_SECRET 与首次启动的 ADMIN_*
docker compose up -d --build
```

- **SQLite 只在 named volume**（`crm-data` → `/data`），不打包进镜像；
  镜像也不含 `.env` / `data/` / `*.sqlite`（见 `.dockerignore`）。
- 前置内网 **Caddy** 做 HTTPS（`caddy reverse-proxy` 到 `crm:3001`），此时 compose 里
  保持 `COOKIE_SECURE=true` + `TRUST_PROXY=true`；若纯 HTTP 直连调试则两者设 `false`。
- `HOST` 非 loopback 且 `COOKIE_SECURE` 非 `true` 时，进程**只 warn 不拒启**
  （pino 输出 `non-loopback bind without COOKIE_SECURE`）——这是提醒补 TLS，不是错误。
- 容器以非 root（`node` 用户）运行；API 用 tsx 直接跑 TS 源码，web 在镜像构建期产出 dist。

### 备份与回滚

SQLite 备份**唯一**配方是 `.backup`（禁止 `cp` 正在 WAL 的热库，K29）：

```bash
docker compose exec crm sh -c 'sqlite3 "$DATABASE_PATH" ".backup /data/gb-crm.bak-$(date +%F)"'
docker cp "$(docker compose ps -q crm)":/data/gb-crm.bak-"$(date +%F)" .
```

（无 `sqlite3` CLI 时可用进程内 `db.backup(dest)`；回滚 = 停容器、回拷 bak、重启。）

### 冒烟测试（e2e）

Playwright 冒烟在 `e2e/`（不挡合并，K28；不进 `npm test`）：

```bash
npm run e2e   # 先构建 web，再起生产模式 api（种子库）跑冒烟
```
