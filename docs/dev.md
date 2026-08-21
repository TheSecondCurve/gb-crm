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

本机要有 `curl` 和 `python3`（macOS 自带）。对着**已经跑着的 CRM** 拉脚本：

```bash
curl -fsSL http://<crm-host>/agent/login.sh | sh
```

本地开发：

```bash
curl -fsSL http://127.0.0.1:3001/agent/login.sh | sh
```

交互输入用户名、密码、范围（`read` / `write`，默认 read）。写入 `~/.gb-crm/credentials.json`（目录 `700`、文件 `600`）。明文 token **不会**打到终端。

非交互：

```bash
GB_CRM_USERNAME=alice GB_CRM_PASSWORD='***' GB_CRM_SCOPE=read \
  curl -fsSL http://<crm-host>/agent/login.sh | sh
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
| `read` | GET；可 `DELETE` 自己的 `/api/v1/auth/tokens/:id` |
| `write` | 上面 + 现有 REST 的 POST/PATCH/DELETE，仍受该用户 `can()` 约束 |

禁用或软删用户会撤销其全部令牌。改自己密码不撤令牌。默认 90 天过期。列表/撤销：`GET` / `DELETE /api/v1/auth/tokens`（Bearer 或 cookie）。

### Skill 包

仓库 `skills/gb-crm/` 是备用包（`SKILL.md` + `scripts/gb-crm.py`），**不会**被 Grok 自动扫描。要用时拷到：

- 本仓库 `.grok/skills/gb-crm/`，或
- 用户目录 `~/.grok/skills/gb-crm/`

Agent 只跑脚本，不要 Read 凭证文件、不要代收密码：

```bash
python3 skills/gb-crm/scripts/gb-crm.py me
python3 skills/gb-crm/scripts/gb-crm.py GET /api/v1/customers q=闪光 pageSize=50
python3 skills/gb-crm/scripts/gb-crm.py POST /api/v1/customers --json '{"nickname":"未命名客户"}'
```

凭证查找顺序：环境变量 `GB_CRM_TOKEN` + `GB_CRM_BASE_URL`，否则 `~/.gb-crm/credentials.json`。没有文件时脚本退出码 2，并提示跑上面的 `login.sh`。

v1 **不**提供任意 SQL 查询/写入 HTTP 接口。写数据走 REST，PATCH 必带 `updatedAt`。
