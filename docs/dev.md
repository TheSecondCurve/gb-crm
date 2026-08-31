## 技术栈

- 前端 react
- 后端 nodejs
- 数据库 sqlite 本地即可

## 规范

- 项目严格按照 TDD 的思路进行开发，需要有严格和完善的测试覆盖
- 工程结构模块化，清晰，符合最佳实践

## 仓库规范

- 总是从 dev 分支拉取 feat/fix 来开发，pr 合并，合并后删除功能分支

## Agent 令牌与 Skill（K35）

架构决策见 `docs/design.md` §5「Agent 个人令牌」与 Key Decision K35。这里只写怎么用。

已部署的库若还没有 `api_tokens` 表，先：

```bash
npm run db:migrate
```

### 签发（无需克隆本仓库）

本机要有 `curl` 和 `python3`（macOS 自带；Windows 用 PowerShell 时不需要 python，`login.ps1` 用 .NET HttpClient）。对着**已经跑着的 CRM** 拉脚本：

macOS / Linux：

```bash
curl -fsSL http://<crm-host>/agent/login.sh | sh
```

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/login.ps1 | iex"
```

本地开发：

```bash
curl -fsSL http://127.0.0.1:3001/agent/login.sh | sh
```

交互输入用户名、密码、范围（`read` / `write`，默认 read）。写入 `~/.gb-crm/credentials.json`（POSIX 目录 `700`、文件 `600`；Windows 尽力收紧 ACL）。明文 token **不会**打到终端。

非交互：

```bash
GB_CRM_USERNAME=alice GB_CRM_PASSWORD='***' GB_CRM_SCOPE=read \
  curl -fsSL http://<crm-host>/agent/login.sh | sh
```

Windows 非交互（PowerShell）：

```powershell
$env:GB_CRM_USERNAME='alice'; $env:GB_CRM_PASSWORD='***'; $env:GB_CRM_SCOPE='read'; irm http://<crm-host>/agent/login.ps1 | iex
```

覆盖签发地址：`GB_CRM_BASE_URL=http://127.0.0.1:3001`。

凭证文件形状：

```json
{
  "baseUrl": "http://127.0.0.1:3001",
  "token": "gbcrm_ro_…",
  "scope": "read",
  "username": "alice"
}
```

之后请求头：`Authorization: Bearer <token>`。不要把 token 写进 git / skill / 对话。

| 范围 | 能做什么 |
| --- | --- |
| `read` | GET；`POST /api/v1/agent/sql` 的只读语句；可 `DELETE` 自己的 `/api/v1/auth/tokens/:id` |
| `write` | 上面 + 现有 REST 的 POST/PATCH/DELETE（仍受该用户 `can()` 约束）+ agent/sql 写语句（写还需 admin） |

禁用或软删用户会撤销其全部令牌。改自己密码不撤令牌。默认 90 天过期。列表/撤销：`GET` / `DELETE /api/v1/auth/tokens`（Bearer 或 cookie）。

### Skill 包

仓库 `skills/gb-crm/` 是备用包（`SKILL.md` + `scripts/gb-crm.py`），**不会**被 Grok 自动扫描。要用时拷到：

- 本仓库 `.grok/skills/gb-crm/`，或
- 用户目录 `~/.grok/skills/gb-crm/`

Agent 只跑脚本，不要 Read 凭证文件、不要代收密码：

```bash
python3 skills/gb-crm/scripts/gb-crm.py me
python3 skills/gb-crm/scripts/gb-crm.py sql "SELECT id, nickname FROM customers WHERE deleted_at IS NULL LIMIT 20"
```

凭证查找顺序：环境变量 `GB_CRM_TOKEN` + `GB_CRM_BASE_URL`，否则 `~/.gb-crm/credentials.json`。没有文件时脚本退出码 2，并提示跑上面的 `login.sh`。

### Skill 远程安装 / 更新（渠道 A，内网 · 免 GitHub）

团队只连内网、访问不了 GitHub 时，由 CRM 服务器直接下发 skill。端点都在 `/agent/*`（不走登录鉴权，信任面同 `/agent/login.sh`）：

| 端点 | 作用 |
| --- | --- |
| `GET /agent/skill/gb-crm/install.sh` | 安装器（shell）：探测 AGENT 技能目录 → 下载 skill → 引导授权 |
| `GET /agent/skill/gb-crm/install.ps1` | 安装器（PowerShell，Windows） |
| `GET /agent/skill/gb-crm/SKILL.md` | skill 主文件 |
| `GET /agent/skill/gb-crm/scripts/gb-crm.py` | python 脚本 |

**对非技术同事，一条命令（回车后输入用户名/密码）**：

macOS / Linux：

```bash
curl -fsSL http://<crm-host>/agent/skill/gb-crm/install.sh | sh
```

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/skill/gb-crm/install.ps1 | iex"
```

安装器行为：校验 `python3`（shell 版；ps1 版探测 `python3`/`python`/`py`，缺则警告仍装文件）→ 探测目标目录（项目级 `./.agents/skills` 优先，否则 `~/.agents/skills` / `~/.codex/skills` / `~/.claude/skills` / `~/.cursor/skills`）→ 下载 `SKILL.md` + `scripts/gb-crm.py` → shell 版 `chmod +x` → 最后复用 `/agent/login.sh`（或 `/agent/login.ps1`）用用户名/密码签发 PAT，写入 `~/.gb-crm/credentials.json`（POSIX 600；Windows 尽力收紧 ACL）。

**更新 = 重跑同一条命令**：每次重跑都会从服务器现取最新 `install.sh`/`install.ps1` 并覆盖 `SKILL.md`/`gb-crm.py`，安装器本体改动自动生效。若本机已有 `~/.gb-crm/credentials.json`，默认**跳过重复授权**、只更新文件；需要重新签发设 `GB_CRM_FORCE_LOGIN=1`；只装文件不授权用 `GB_CRM_SKIP_LOGIN=1`。

**让 AGENT 替非技术用户装**（把这段话交给对方 AGENT；密码不经 AGENT）：

```
请帮我安装 gb-crm skill：
  macOS/Linux 运行 `curl -fsSL http://<crm-host>/agent/skill/gb-crm/install.sh | sh`；
  Windows 运行 `powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/skill/gb-crm/install.ps1 | iex"`。
若缺 python3 就告诉我；不要读取或回显 ~/.gb-crm/credentials.json，别让我在对话里输密码。
```

安全：skill 不含任何密钥；凭证只写本地 `~/.gb-crm/credentials.json`(600)；安装器对 `Host` 做白名单校验（非法值回退 `127.0.0.1:3001`，防 shell 注入）。生产容器需将 `skills/` 拷进镜像（`Dockerfile` runtime 阶段 `COPY skills ./skills`，已含）。安装验证：`python3 ~/.agents/skills/gb-crm/scripts/gb-crm.py me` 能回显当前用户。

Agent 数据访问走单一自由 SQL 端点 `POST /api/v1/agent/sql`（仅 Bearer PAT）：`stmt.readonly` 判读写，只读语句任意 scope / 角色放行，写语句必须 admin + write scope；单语句；读上限 1000 行截断——详见 `skills/gb-crm/SKILL.md` 与 design.md K35。REST 资源路由保留给 web 管理端。
