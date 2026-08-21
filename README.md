# gb-crm — 闪光 · 客户运营

闪光团队客户信息管理系统。pnpm + TypeScript monorepo：

- `apps/web` — Vite + React 管理端（中文 UI）
- `apps/api` — Fastify + Drizzle + SQLite（WAL）REST API
- `packages/shared` — 两端共享的 Zod schema、枚举与 ACL

完整架构与实现约束见 `docs/design.md`。

## 本地开发

环境：Node 22（见 `.nvmrc`）+ pnpm（corepack 启用）。

```bash
cp .env.example .env          # 填 SESSION_SECRET（≥32 字符）与 ADMIN_*
pnpm install
pnpm db:migrate
pnpm dev                      # api :3001 + web :5173（Vite 代理 /api → :3001）
```

常用命令：

```bash
pnpm lint        # eslint（全部包）
pnpm typecheck   # tsc --noEmit（全部包）
pnpm test        # vitest（全部包；api 带 v8 覆盖率门禁）
```

### macOS 编译 better-sqlite3

`better-sqlite3` 需要本地编译工具链：Xcode Command Line Tools 与 Python 3。

```bash
xcode-select --install
```

CI 使用官方 Node 22 环境，无需额外处理。

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

内网 Docker 单进程（设计 K32）：`Dockerfile` 与 `docker-compose.yml` 在 PR 14 提供。
要点：SQLite 走 named volume（不进镜像）、前置内网 Caddy 做 HTTPS、`COOKIE_SECURE=true`、`TRUST_PROXY=true`；同一 Fastify 进程托管 `/api` 与 `apps/web/dist`（SPA fallback）。
