---
name: gb-crm
description: >
  闪光 · 客户运营（gb-crm）本机 HTTP 客户端。用 ~/.gb-crm/credentials.json 的 PAT
  通过单一 SQL 端点查询或维护客户、渠道、产品、团队成员。当用户提到 CRM、客户名单、
  渠道资产、产品目录、团队成员、gb-crm、闪光客户运营，或要查/改客户时使用。
  Use when the user runs /gb-crm.
metadata:
  short-description: 用本机 PAT 对 gb-crm 跑 SQL
  compatibility: Requires python3
---

# gb-crm

品牌文案锁定 **「闪光 · 客户运营」**，禁止「女商」。

`SKILL_DIR` = 本文件所在目录。所有 HTTP **只**走脚本，不要自己拼 `Authorization`，不要 Read `~/.gb-crm/credentials.json`，不要把 token / 密码写进对话或命令行。

## 用法（主路径：一条 SQL）

```bash
python3 "$SKILL_DIR/scripts/gb-crm.py" sql "SELECT id, nickname FROM customers WHERE deleted_at IS NULL LIMIT 20"
python3 "$SKILL_DIR/scripts/gb-crm.py" me    # 我是谁：id / username / nickname / systemRole
```

脚本把 SQL 拼成 `POST /api/v1/agent/sql` 的 `{ "sql": "..." }`。

- **读**（`SELECT` / `WITH ... SELECT` / `PRAGMA`）：`{ data: { columns, rows, rowCount, truncated } }`。`rows` 是**数组**（顺序对齐 `columns`），不是对象。最多返回 **1000 行**，超出 `truncated: true`——分页用 `LIMIT/OFFSET` 或加 `WHERE` 收敛，别忘了 `ORDER BY`。
- **写**（`INSERT/UPDATE/DELETE`）：`{ data: { changes, lastInsertRowid } }`。仅限 **admin + write scope** 令牌，否则 403「仅管理员可执行写 SQL」。
- 一次只能**一条语句**（多语句 → 422）。`INSERT ... RETURNING` 算写。
- 错误信封 `{ error: { code, message } }`：`SQL_ERROR`（422，message 是 sqlite 原文）、`FORBIDDEN`（403）、`VALIDATION`（422）。脚本 stderr 第一行是 `HTTP <status>`；401 时提示重新签发。
- cookie 会话（web 管理端）不能调这个端点，仅 Bearer PAT。

## 凭证

查找顺序：`GB_CRM_TOKEN` + `GB_CRM_BASE_URL`，否则 `~/.gb-crm/credentials.json`。没有文件 → 让用户**自己**在终端跑（你不要代收密码）：

```bash
curl -fsSL http://<crm-host>/agent/login.sh | sh
```

本仓库本地开发默认 `http://127.0.0.1:3001`。范围 `read` / `write`：读 SQL 两者都行；写 SQL 要 `write` 且账号是 admin。

本机 python 缺 CA 证书报 `CERTIFICATE_VERIFY_FAILED` 时，优先修证书（macOS python.org 版跑 `Install Certificates.command`）。本脚本（gb-crm.py）**默认已跳过 TLS 校验**，修好证书后可设 `GB_CRM_INSECURE=0` 恢复校验；`login.sh` 签发脚本默认校验，需要时显式 `GB_CRM_INSECURE=1`。跳过校验时中间人可拿到密码/token，别在不可信网络用。

## 工作守则

1. 先 `me`，记下自己的 `id` 与 `systemRole`。
2. 查数据前先看下面的表结构；**默认过滤软删**：`WHERE deleted_at IS NULL`（sessions / api_tokens / join 表无此列）。
3. 写数据只在用户明确要求时做；删除前复述将删的行并得到确认。删除 = **软删**：`UPDATE ... SET deleted_at = <now>`，不要 `DELETE FROM`。
4. 写时**手动维护** `updated_at = <当前 epoch 毫秒>`、`updated_by = <自己的 user id>`（`me` 拿到）；新建行同理补 `created_at` / `created_by`。
5. 时间戳一律 **epoch 毫秒**（UTC）。金额 `price_cents` 是**分**，展示元；不要 `yuan * 100` 不 round 就写入。布尔 `is_package` 是 0/1。
6. 写 SQL 绕过管理端的 PATCH 内核 / OCC / 审计，**只做简单 CRUD**，不要 DDL（CREATE/DROP/ALTER），不要动 `sessions` / `api_tokens`。
7. 403 不要换字段重试同一越权操作；需要写权限就让用户换 admin 的 write 令牌重新签发。

## 表结构

真相源：`apps/api/drizzle/0000_init.sql`。列全部 snake_case（SQL 层没有 camelCase）。

### users（团队成员）

| 列 | 类型 | 含义 |
| --- | --- | --- |
| id | INTEGER PK | |
| username / password_hash | TEXT | 登录名 / argon2id hash（永不读给用户看） |
| nickname / real_name | TEXT | 昵称（必填）/ 真实姓名 |
| phone / wechat | TEXT | |
| job_title | TEXT | 岗位，枚举见下，默认 `other` |
| system_role | TEXT | 登录权限 `admin`/`operator`/`assistant`，NULL = 无登录 |
| employment_status | TEXT | `employed`/`handing_over`/`left`，默认 `employed` |
| account_status | TEXT | 闸门 `enabled`/`disabled`，默认 `disabled` |
| duties / notes | TEXT | 职责 / 备注 |
| created_at / updated_at | INTEGER | epoch 毫秒 |
| created_by / updated_by | INTEGER | → users.id |
| deleted_at | INTEGER | 软删 |
| feishu_record_id / feishu_user_id | TEXT | 历史列，忽略 |

### customers（客户）

| 列 | 类型 | 含义 |
| --- | --- | --- |
| id | INTEGER PK | |
| nickname / real_name / title | TEXT | 昵称（必填）/ 姓名 / 头衔 |
| phone / wechat / other_social | TEXT | |
| wechat_channels_account / xiaoyuzhou_account / xiaohongshu_account / weibo_account / douyin_account | TEXT | 各平台账号 |
| country / city | TEXT | |
| origin_story / notes / profile_url | TEXT | 来历 / 备注 / 主页 |
| customer_type | TEXT | 枚举见下，默认 `customer` |
| parent_id | INTEGER | → customers.id（父客户，≤2 层） |
| wechat_openid | TEXT | 预留，可空唯一（live 行内唯一） |
| last_followed_at | INTEGER | 最近跟进，epoch 毫秒 |
| created_at / updated_at / created_by / updated_by / deleted_at | | 同上 |
| feishu_record_id / feishu_created_date | | 历史列，忽略 |

关联（join 表，无主键以外的列，联合主键）：

- `customer_tags(customer_id, tag)`：标签，tag 枚举见下。
- `customer_owners(customer_id, user_id)`：归属人。
- `customer_upsell_owners(customer_id, user_id)`：升单人。
- `customer_source_channels(customer_id, channel_id)`：来源渠道。
- `customer_community_channels(customer_id, channel_id)`：社群渠道。

### channels（渠道资产）

| 列 | 类型 | 含义 |
| --- | --- | --- |
| id / name / description | | name 必填 |
| account_id / register_phone / registrant / real_name_person / login_device | TEXT | **密钥字段**（SQL 端点全角色可读，仍属敏感信息，别主动展示） |
| platform / channel_type / account_type / status | TEXT | 枚举见下 |
| follower_count | INTEGER | 粉丝数 |
| notes | TEXT | |
| created_at / updated_at / created_by / updated_by / deleted_at | | 同上 |

- `channel_owners(channel_id, user_id)`：渠道负责人。

### products（产品）

| 列 | 类型 | 含义 |
| --- | --- | --- |
| id / name / notes | | name 必填 |
| sop_url / package_includes / delivery_cycle | TEXT | SOP / 套餐内容 / 交付周期 |
| product_type | TEXT | 枚举见下，默认 `c_consulting` |
| is_package | INTEGER | 0/1 |
| status | TEXT | `on_sale`/`off_sale`/`in_dev` |
| price_cents | INTEGER | 分；NULL = 未定价 |
| created_at / updated_at / created_by / updated_by / deleted_at | | 同上 |

### 系统表（别动）

`sessions`（cookie 会话）、`api_tokens`（PAT，只有 hash）——认证用，看一眼结构即可，**不要写**。

## 枚举 code → 中文（完整表，对齐 `packages/shared/src/labels.ts`）

- system_role：`admin` 管理员 / `operator` 团队运营 / `assistant` 兼职助手
- job_title：`ip` IP / `partner` 合伙人 / `ops` 运营 / `assistant` 助理 / `content` 内容 / `other` 其他 / `part_time_helper` 兼职小助手 / `intern` 实习生
- employment_status：`employed` 在职 / `handing_over` 交接中 / `left` 已离职
- account_status：`enabled` 有效 / `disabled` 失效
- customer_type：`guest` 嘉宾 / `customer` 客户 / `company` 企业 / `invite` 邀请 / `partner` 合作伙伴
- tag：`stage_0_1` 业务阶段 0-1 / `stage_1_10` 1-10 / `stage_10_100` 10-100 / `vip` VIP / `ip` IP / `side_hustle` 副业 / `guest` 嘉宾 / `partner` 合作伙伴
- platform：`wechat` 微信 / `weibo` 微博 / `xiaohongshu` 小红书 / `douyin` 抖音 / `xiaoyuzhou` 小宇宙 / `other` 其他 / `bilibili` Bilibili / `xigua` 西瓜视频 / `wechat_channels` 微信视频号
- channel_type：`private` 私域 / `public` 公域 / `private_assistant` 私域助手号 / `public_assistant` 公域助手号 / `fixed_wechat` 固定微信
- account_type：`public_account` 公域账号 / `private_assistant` 私域助手号 / `fixed_wechat` 固定微信 / `wechat_group` 微信群 / `weibo_group` 微博群 / `xhs_group` 小红书群
- channel status：`operating` 运营中 / `paused` 暂停 / `pending` 待开通
- product_type：`c_consulting` C端咨询 / `b_consulting` B端咨询 / `ad_coop` 广告合作 / `content_coop` 内容合作 / `knowledge` 知识付费 / `circle_sub` 圈子订阅 / `campaign` 运营活动 / `team_delivery` 团队交付
- product status：`on_sale` 在售 / `off_sale` 停售 / `in_dev` 开发中

对用户列出结果时用昵称/名称与中文 label，不要甩一堆 id 和 code；需要跟进时再附 id。

## 通用 HTTP（备用，非主路径）

REST 资源路由仍服务 web 管理端。SQL 端点做不到的事（如撤销令牌）可用通用形式：

```bash
python3 "$SKILL_DIR/scripts/gb-crm.py" GET /api/v1/auth/tokens
python3 "$SKILL_DIR/scripts/gb-crm.py" DELETE /api/v1/auth/tokens/3
python3 "$SKILL_DIR/scripts/gb-crm.py" GET /api/v1/customers q=闪光 pageSize=50
```
