---
name: gb-crm
version: 0.11.0
description: >
  女商 私域运营管理端（gb-crm）本机 HTTP 客户端。用 ~/.gb-crm/credentials.json 的 PAT
  通过单一 SQL 端点查询或维护客户、渠道、产品、团队成员、成交记录、交付管理与资料。
  当用户提到 CRM 查找（查客户/名单/资料/语料）、CRM 更新（增改删客户/渠道/产品/成交/交付/
  资料/维护记录）、客户跟进、新增客户维护（给客户记一条维护记录/状态变化/线索/备注）
  这类对系统的增删改查操作，或提到 CRM、客户名单、渠道资产、产品目录、团队成员、成交、交付、
  资料、语料、gb-crm、女商私域运营管理端，或要查/改客户时使用。
  Use when the user runs /gb-crm.
metadata:
  short-description: 用本机 PAT 对 gb-crm 跑 SQL
  compatibility: Requires python3
---

# gb-crm

品牌文案 **「女商 私域运营管理端」**。

`SKILL_DIR` = 本文件所在目录。所有 HTTP **只**走脚本，不要自己拼 `Authorization`，不要 Read `~/.gb-crm/credentials.json`，不要把 token / 密码写进对话或命令行。

## 安装 / 更新（内网，免 GitHub）

若本 skill 尚未安装或需更新，让用户**自己**在终端跑一条命令（安装器会把 skill 文件装到当前 AGENT、codex 全局 `~/.codex/skills`、claude 全局 `~/.claude/skills` 三处，并在本机授权；密码只在终端输入、不经 AGENT）：

macOS / Linux：

```bash
curl -fsSL http://<crm-host>/agent/skill/gb-crm/install.sh | sh
```

Windows（PowerShell；已装 python 则 `python3` 换成 `python` 或 `py`）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm http://<crm-host>/agent/skill/gb-crm/install.ps1 | iex"
```

装完即可用：当前 AGENT 调用本 skill；codex / claude 也能在同一台机器的各自全局 SKILL 目录里发现并加载它。

**更新 = 重跑同一条命令**。安装器每次都会从服务器拉取最新文件覆盖 `SKILL.md`/`gb-crm.py`（`install.sh`/`install.ps1` 本身也是每次现取，改动自动生效）。若本机已有 `~/.gb-crm/credentials.json`，默认**跳过重复授权**、只更新文件；需要重新签发时再设 `GB_CRM_FORCE_LOGIN=1`，或只装文件不授权用 `GB_CRM_SKIP_LOGIN=1`（之后自行跑 `/agent/login.sh` 或 `/agent/login.ps1`）。

## 用法（主路径：一条 SQL）

```bash
python3 "$SKILL_DIR/scripts/gb-crm.py" sql "SELECT id, nickname FROM customers WHERE deleted_at IS NULL LIMIT 20"
python3 "$SKILL_DIR/scripts/gb-crm.py" me    # 我是谁：id / username / nickname / systemRole
```

**上传文件资料**（`kind=file`，POST /api/v1/materials/upload，multipart；一次请求同时建行 + 挂交付 + 挂客户 + 挂标签）：

```bash
python3 "$SKILL_DIR/scripts/gb-crm.py" upload ./录音稿.pdf title="3月下午茶整场" deliveryId=12 customerIds='[3,5]' newTagNames='["下午茶"]'
```

文件**必须小于 32MB**（超限请先压缩/拆分）；`title` 必填，`deliveryId` 是数字、`customerIds`/`tagIds`/`newTagNames` 是 JSON 数组字符串；同样需要 admin/operator + write scope。上传前先按「资料」一节的规则匹配/新建交付单拿到 `deliveryId`。

Windows 上若命令 `python3` 不存在，用 `python` 或 `py`（如 `py "$SKILL_DIR/scripts/gb-crm.py" me`）。脚本本身无第三方依赖，跨平台。

脚本把 SQL 拼成 `POST /api/v1/agent/sql` 的 `{ "sql": "..." }`。

- **读**（`SELECT` / `WITH ... SELECT` / `PRAGMA`）：`{ data: { columns, rows, rowCount, truncated } }`。`rows` 是**数组**（顺序对齐 `columns`），不是对象。最多返回 **1000 行**，超出 `truncated: true`——分页用 `LIMIT/OFFSET` 或加 `WHERE` 收敛，别忘了 `ORDER BY`。
- **写**（`INSERT/UPDATE/DELETE`）：`{ data: { changes, lastInsertRowid } }`。仅限 **admin/operator + write scope** 令牌，否则 403「仅管理员与运营可执行写 SQL」。**DDL（CREATE/ALTER/DROP）对任何令牌一律 403**「SQL 端点禁止执行 DDL（CREATE / ALTER / DROP）」——端点层已强制，想改表结构走管理端/迁移。
- 一次只能**一条语句**（多语句 → 422）。`INSERT ... RETURNING` 算写。
- 错误信封 `{ error: { code, message } }`：`SQL_ERROR`（422，message 是 sqlite 原文）、`FORBIDDEN`（403）、`VALIDATION`（422）。脚本 stderr 第一行是 `HTTP <status>`；401 时提示重新签发。
- cookie 会话（web 管理端）不能调这个端点，仅 Bearer PAT。

## 凭证

查找顺序：`GB_CRM_TOKEN` + `GB_CRM_BASE_URL`，否则 `~/.gb-crm/credentials.json`。没有文件 → 让用户**自己**在终端跑（你不要代收密码）：

```bash
curl -fsSL http://<crm-host>/agent/login.sh | sh
```

本仓库本地开发默认 `http://127.0.0.1:3001`。范围 `read` / `write`：读 SQL 两者都行；写 SQL 要 `write` 且账号是 admin 或 operator。

本机 python 缺 CA 证书报 `CERTIFICATE_VERIFY_FAILED` 时，优先修证书（macOS python.org 版跑 `Install Certificates.command`）。本脚本（gb-crm.py）**默认已跳过 TLS 校验**，修好证书后可设 `GB_CRM_INSECURE=0` 恢复校验；`login.sh` 签发脚本默认校验，需要时显式 `GB_CRM_INSECURE=1`。跳过校验时中间人可拿到密码/token，别在不可信网络用。

## 工作守则

1. 先 `me`，记下自己的 `id` 与 `systemRole`。
2. **「我的」= 等值过滤，不是权限收紧**（助理/运营本身就能读全量，这一步只是按当前账号收敛查询范围）：用户说「我的客户 / 我的成交 / 我负责的 / 我名下的」→ 必须在 SQL 里写 `WHERE owner_id = <自己的 user id>`——这个 id 就是规则 1 里 `me` 拿到的 `id`（`customers.owner_id`、`deals.owner_id` 同理）。用户说「所有客户 / 全部客户 / 客户名单 / 全量」→ **不要**加 owner 过滤，默认只 `WHERE deleted_at IS NULL`。用户说「某人的客户」（如「小王的」）→ 先按昵称查到那个人的 `id`，再用其 `owner_id` 过滤——「我的」永远只等于当前令牌账号自己。拿不准（如「闪光那边的客户」）→ 先复述「只看我名下，还是全部？」确认再查。
3. 查数据前先看下面的表结构；**默认过滤软删**：`WHERE deleted_at IS NULL`（sessions / api_tokens / delivery_tasks / delivery_customers / delivery_material_customers / delivery_material_tags / channel_owners / customer_source_channels / customer_social_accounts / customer_tags 无此列）。
4. 写数据只在用户明确要求时做；删除前复述将删的行并得到确认。删除 = **软删**：`UPDATE ... SET deleted_at = <now>`，不要 `DELETE FROM`。
5. 写时**手动维护** `updated_at = <当前 epoch 毫秒>`、`updated_by = <自己的 user id>`（`me` 拿到）；新建行同理补 `created_at` / `created_by`。
6. 时间戳一律 **epoch 毫秒**（UTC）。金额 `price_cents` 是**分**，展示元；不要 `yuan * 100` 不 round 就写入。布尔 `is_package` 是 0/1。
7. 写 SQL 绕过管理端的 PATCH 内核 / OCC / 审计，**只做简单 CRUD**，不要动 `sessions` / `api_tokens`。DDL（CREATE/ALTER/DROP）端点已直接 403，无需也不会执行。
8. 403 不要换字段重试同一越权操作；需要写权限就让用户换 admin/operator 的 write 令牌重新签发。

## 业务背景：助手号 → 当前管理人 → 归属销售

渠道里有一大批**微信小助手账号**（`platform='wechat'`，`channel_type`/`account_type` 多为 `private_assistant` 或 `fixed_wechat`，名字形如「斯斯小助手-叶子」「闪光小助手-三江」）。客户的定位靠这条链：

- 客户 →（M2M `customer_source_channels(customer_id, channel_id)`）→ **来源渠道**（哪个助手号加进来的）；
- 渠道 →（M2M `channel_owners(channel_id, user_id)`）→ **当前管理人**（哪个团队成员在运营这个号）；
- 管理人 = 该客户的**归属销售**，落在 `customers.owner_id`（单值列）。

`channel_owners` 表达的是**当下**的归属：号会换人管，管理人变了只影响之后的客户定位，已入库客户的 `owner_id` 不会自动跟着改。

**触发与指令**：用户说「这个客户是 XX 账号的」「XX 号加的客户」「把这个客户归到 XX 账号」时，不要只按昵称猜人——XX 是**助手号名**，要做两步定位：

```sql
-- 1) 按助手号名定位渠道（模糊匹配名字后缀，注意同名渠道可能存在多条）
SELECT c.id, c.name, u.id AS owner_id, u.nickname AS owner
FROM channels c
LEFT JOIN channel_owners co ON co.channel_id = c.id
LEFT JOIN users u ON u.id = co.user_id
WHERE c.deleted_at IS NULL AND c.platform = 'wechat' AND c.name LIKE '%叶子%';
```

2) 查到渠道后，对客户**同时做两件事**（写操作需用户明确要求）：

```sql
-- a. 挂来源渠道（M2M，已存在则忽略）
INSERT OR IGNORE INTO customer_source_channels (customer_id, channel_id) VALUES (?, ?);
-- b. 归属销售 = 渠道当前管理人（同守则 5 补 updated_at/updated_by）
UPDATE customers SET owner_id = ?, updated_at = ?, updated_by = ? WHERE id = ?;
```

边界情况：渠道查不到（名字记错）→ 报出近似候选让用户选；渠道**没有当前管理人**（`channel_owners` 无行）→ 如实告知「该号当前无人认领」，只挂来源渠道、`owner_id` 不动，让用户定夺；渠道有**多个管理人** → 列出全部让用户指定归属销售。反过来，只改归属人不动来源渠道（「这客户转给小王跟」→ 只 `UPDATE customers.owner_id`）、只补来源渠道不动归属人的场景也存在，按用户说的做，不要互相牵连。

## 表结构

真相源：`apps/api/drizzle/` 迁移最终态（`0000_init.sql` 为历史；`0002`–`0006` 删除飞书字段/客户旧字段/客户标签；`0007` 社交账号表 K41；`0008` 成交表 K42；`0010` 交付重构 K44，`0009` 旧交付模型 DROP 重建；`0012`–`0014` 交付起止日期/类型 kind+status/交付项排期；`0020` 资料 + FTS5（K54）；`0026` 资料标签（K58））。列全部 snake_case（SQL 层没有 camelCase）。

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

### customers（客户）

| 列 | 类型 | 含义 |
| --- | --- | --- |
| id | INTEGER PK | |
| nickname / real_name / title | TEXT | 昵称（必填）/ 姓名 / 头衔 |
| phone / wechat | TEXT | |
| country / city | TEXT | |
| origin_story / notes | TEXT | 来历 / 备注 |
| customer_type | TEXT | 枚举见下，默认 `customer` |
| wechat_openid | TEXT | 预留，可空唯一（live 行内唯一） |
| last_followed_at | INTEGER | 最近跟进，epoch 毫秒 |
| owner_id | INTEGER | 归属人，单值可空 FK → users.id（K39，非 join 表） |
| created_at / updated_at / created_by / updated_by / deleted_at | | 同上 |

社交账号（K41）：`customer_social_accounts(customer_id, platform, account, …审计列)`，platform 枚举见下，同平台可多账号。归属人是 customers 表上的单值可空列（K39，不是 join 表）：`customers.owner_id` → users.id。

来源渠道 join 表：`customer_source_channels(customer_id, channel_id)`。

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

### deals（成交记录，K42）

| 列 | 类型 | 含义 |
| --- | --- | --- |
| id | INTEGER PK | |
| customer_id | INTEGER NOT NULL FK | 客户，必填 → customers.id |
| product_id | INTEGER | 意向产品，可空 FK → products.id |
| owner_id | INTEGER | 负责人，单值可空 FK → users.id |
| stage | TEXT | 默认 `gift`，枚举见下 |
| order_no | TEXT | 订单号 |
| payment_remark | TEXT | 支付信息备注 |
| delivery_date | INTEGER | 交付日期，epoch 毫秒，可空 |
| created_at / updated_at / created_by / updated_by / deleted_at | | 同上（软删） |

### 交付管理（K44）

交付与成交**弱关联**：交付单独立存在，客户来源可来自成交 merge（前端交互，不持久化关联）。

- `delivery_types`（交付类型配置）：`name`（必填）/ `kind`（`consulting` 咨询类/`activity` 活动类/`circle` 圈子类/`other` 其他类，默认 `other`）/ `status`（`active` 有效/`inactive` 失效，默认 `active`）/ `description` / `default_tasks`（多行文本，每行一个默认动作，创建交付项时预填）；软删。
- `deliveries`（交付单）：`delivery_type_id`（必填 FK → delivery_types.id）/ `starts_at` / `ends_at`（起止日期，epoch 毫秒，可空）/ `remark`；软删。
- `delivery_customers`（交付 × 客户 M2M）：`(delivery_id, customer_id)` 复合 PK；**硬删**，无审计列。
- `deliverables`（交付项，挂交付单）：`delivery_id`（必填 FK，cascade）/ `content`（必填，如「拉群」）/ `dimension`（`project`/`customer`，默认 `project`）/ `description` / `delivery_url` / `starts_at` / `ends_at`（排期，可空）；软删。无独立状态，打勾进度即状态。
- `delivery_tasks`（动作清单，交付项子表）：`deliverable_id`（必填 FK，cascade）/ `customer_id`（**可空**，NULL = 项目维度；客户维度按 customer 分别打勾）/ `content` / `done`（0/1）/ `done_at` / `done_by` / `remark`；**硬删**，无 deleted_at。

### 资料（K54/K58）

领域模型：资料是**交付的产出物**，挂在交付单上；交付不只有咨询——`delivery_types.kind` 分 `consulting` 咨询 / `activity` 活动 / `circle` 圈子 / `other` 其他（如微博365连麦、线下1v1咨询是 consulting，商业下午茶是 activity：一场 5-6 人，客户走 `delivery_customers`）。匹配关系与库结构一致：`delivery_materials.delivery_id` 是**可空** FK → deliveries.id，NULL = 未关联交付的孤儿（只应作为历史遗留/过渡状态存在）。

- `delivery_materials`（资料）：`delivery_id`（可空 FK，见上）/ `kind`（`transcript` 录音文字稿 / `text` 文本资料 / `audio` 音频 / `video` 视频 / `link` 其他链接 / `file` 对象存储）/ `title`（必填，标题+说明）/ `url`（媒体类必填）/ `content`（**文本类全文**，可上万字）/ `object_key` / `content_type` / `file_size` / `original_filename`（仅 `kind=file`）；审计四列 + `deleted_at` 软删。组合约束（管理端 Zod 强制，写 SQL 时自觉遵守）：`transcript`/`text` 必须有 `content`，`audio`/`video`/`link` 必须有 `url`，`file` 必须有 `object_key`（**kind=file 走脚本的 `upload` 子命令**（见「用法」），不要手写 SQL 塞二进制——手写 INSERT 没有真实对象存储文件，管理端下载会坏）。
- `delivery_material_customers`（资料 × 客户 M2M）：`(material_id, customer_id)` 复合 PK，0..N——**一份资料可属多个人**（如下午茶整场录音稿挂全部参会者），0 行 = 未关联客户；**硬删**，无审计列。

**新增资料先落交付单**（按语义匹配，不限咨询类）：

1. **匹配**：按交付类型名 / 起止日期 / 关联客户收窄，查 live 交付单（`deliveries` JOIN `delivery_types`，两边都 `deleted_at IS NULL`），列出候选让用户确认后填 `delivery_id`；
2. **新建**：没有合适的交付单就新建一条——先查 `delivery_types`（`deleted_at IS NULL AND status='active'`）选语义贴合的类型（kind 不限 consulting，活动/圈子/其他都可以）；连类型都不贴切就先跟用户确认，不要硬塞。新交付单补审计四列，参与客户走 `delivery_customers`；
3. 不要主动造孤儿资料；只有用户明确说「先不关联交付」时才留 `delivery_id = NULL`。

全文搜索（FTS5，`trigram` 分词，中文子串友好）：

```sql
-- 索引表 delivery_materials_fts 由触发器自动同步（软删的行自动移出索引），不要手写它
SELECT m.id, m.title FROM delivery_materials m
WHERE m.deleted_at IS NULL
  AND m.id IN (SELECT rowid FROM delivery_materials_fts
               WHERE delivery_materials_fts MATCH '"私域运营"');
```

- MATCH token 必须 **≥3 个字符**（trigram），用双引号包裹；短词（如 2 字「咨询」）退回 `LIKE '%咨询%'`（title 和 content 两列）。
- 常用过滤：`kind = 'transcript'`、孤儿资料 `delivery_id IS NULL OR NOT EXISTS (SELECT 1 FROM delivery_material_customers mc WHERE mc.material_id = m.id)`、某客户的资料 `JOIN delivery_material_customers mc ON mc.material_id = m.id AND mc.customer_id = ?`。
- 写资料时同守则 4 补审计列；软删走 `UPDATE ... SET deleted_at = <now>`（触发器会清 FTS，不用管）。

**资料标签（K58）**：资料词与客户词同在 `tags` 表，按 `domain` 分域（`customer` / `material`），live 唯一按 `(domain, name)`——同名词在两域可以并存，解析时**必须带域**。关联表 `delivery_material_tags`：`(material_id, tag_id)` 复合 PK + `created_at`/`created_by`；**硬删**，无 `deleted_at`（同 customer_tags 形态）。

加标签：按名字解析时带 `AND domain='material'`：

```sql
SELECT id FROM tags WHERE name=? AND domain='material' AND deleted_at IS NULL;
```

同名 live 资料词直接复用；词表没有时**直接建** material 域行（`scope='other'`、`enabled=1`、补 `created_at`/`created_by` 审计列）——与客户词表「先跟用户确认再建行」不同，资料词**免审批**（与管理端资料表单 `newTagNames` 行为一致）。然后：

```sql
INSERT OR IGNORE INTO delivery_material_tags (material_id, tag_id, created_at, created_by) VALUES (?, ?, <now>, <me>);
```

删标签：`DELETE FROM delivery_material_tags WHERE material_id=? AND tag_id=?`（先按名字解析出 `tag_id`，删前向用户复述）。

### 客户维护记录（K55）

销售为每个客户随手记录跟进触点，纯时间线表达客户状态（**不新增 `customers.status` 列**）。一张记录对应一个客户（`customer_id` → `customers.id`），单表标量时间线，**无父子 / 无 M2M / 无多态 / 无 FTS**。

- `customer_maintenance_records`（维护记录，软删）：`customer_id`（必填，指向客户）/ `kind`（必填，枚举见下）/ `happened_at`（记录对应的时间点，epoch 毫秒，**可回填**补录旧记录，与 `created_at` 分开）/ `content`（自由文本，可空）；审计四列 + `deleted_at` 软删。
- kind 枚举（CHECK 限定）：`follow_up` 跟进 / `status_change` 状态变化 / `lead` 线索 / `note` 备注 / `other` 其他。

**触发与指令**：用户说「**客户跟进**」「**新增客户维护**」「给客户记一条跟进/记录」「客户状态变化」「补一条线索/备注」等，一律走本表**新增一条记录**，不要往 `customers` 塞列。`kind` 按语义取（无需用户说枚举值）：跟进/回访/联系 → `follow_up`；状态变了（改主意/转介绍）→ `status_change`；新意向/线索 → `lead`；随手记 → `note`/`other`。`content` = 用户描述的事；`happened_at` 未说明则用现在，说明「补记周五那次/上次」就给对应时间点（可回填）。一律落在某个 `customer_id` 上——先按昵称找到对应客户，找不到就明确告知。

**写记录约定**：skill 直写 SQL，绕过了 service 层，需手动对齐管理端行为——

- 同守则 4/5：软删只更新 `deleted_at`，不硬删；补 `created_at`/`created_by`、`updated_at`/`updated_by`。
- `kind` 为 `follow_up` / `lead`（跟进/线索）时，**同步刷新该客户的 `customers.last_followed_at`**，取「当前值与本次 `happened_at` 的较大者」——与「最近跟进」展示保持一致。

### 客户标签（K45）

- `tags`（词表，软删）：`name`（必填）/ `domain`（`customer` 客户 / `material` 资料，缺省 customer；live 唯一按 `(domain, name)`，同名跨域允许）/ `scope`（`identity` 身份 / `stage` 阶段 / `interest` 兴趣 / `other` 其它）/ `enabled` 0/1 / `sort`；审计四列 + `deleted_at`。
- `customer_tags`（客户 × 标签 M2M）：`(customer_id, tag_id)` 复合 PK + `created_at`/`created_by`；**硬删**，无 `deleted_at`。

资料侧的标签词（`domain='material'`）与 `delivery_material_tags` 见上面「资料」一节。

**加标签**：先按名字解析词表 `SELECT id FROM tags WHERE name=? AND domain='customer' AND deleted_at IS NULL`，同名 live 词直接复用；词表没有先跟用户确认再建行（补 `scope`/`enabled=1`/审计列，domain 缺省即 customer）。然后：

```sql
INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, created_at, created_by) VALUES (?, ?, <now>, <me>);
```

**删标签**：join 表唯一允许的硬删——`DELETE FROM customer_tags WHERE customer_id=? AND tag_id=?`（先按名字解析出 `tag_id`，删前向用户复述）。

### 系统表（别动）

`sessions`（cookie 会话）、`api_tokens`（PAT，只有 hash）——认证用，看一眼结构即可，**不要写**。

## 枚举 code → 中文（完整表，对齐 `packages/shared/src/labels.ts`）

- system_role：`admin` 管理员 / `operator` 团队运营 / `assistant` 兼职助手
- job_title：`ip` IP / `partner` 合伙人 / `ops` 运营 / `assistant` 助理 / `content` 内容 / `other` 其他 / `part_time_helper` 兼职小助手 / `intern` 实习生
- employment_status：`employed` 在职 / `handing_over` 交接中 / `left` 已离职
- account_status：`enabled` 有效 / `disabled` 失效
- customer_type：`guest` 嘉宾 / `customer` 客户 / `company` 企业 / `invite` 邀请 / `partner` 合作伙伴
- social_platform：`wechat_channels` 视频号 / `xiaoyuzhou` 小宇宙 / `xiaohongshu` 小红书 / `weibo` 微博 / `douyin` 抖音 / `other` 其他（K41，客户社交账号）
- platform：`wechat` 微信 / `weibo` 微博 / `xiaohongshu` 小红书 / `douyin` 抖音 / `xiaoyuzhou` 小宇宙 / `other` 其他 / `bilibili` Bilibili / `xigua` 西瓜视频 / `wechat_channels` 微信视频号
- channel_type：`private` 私域 / `public` 公域 / `private_assistant` 私域助手号 / `public_assistant` 公域助手号 / `fixed_wechat` 固定微信
- account_type：`public_account` 公域账号 / `private_assistant` 私域助手号 / `fixed_wechat` 固定微信 / `wechat_group` 微信群 / `weibo_group` 微博群 / `xhs_group` 小红书群
- channel status：`operating` 运营中 / `paused` 暂停 / `pending` 待开通
- product_type：`c_consulting` C端咨询 / `b_consulting` B端咨询 / `ad_coop` 广告合作 / `content_coop` 内容合作 / `knowledge` 知识付费 / `circle_sub` 圈子订阅 / `campaign` 运营活动 / `team_delivery` 团队交付
- product status：`on_sale` 在售 / `off_sale` 停售 / `in_dev` 开发中
- deal stage：`gift` 赠送 / `paid` 已付款 / `refunded` 退款 / `closed` 已关闭
- deliverable dimension：`project` 项目 / `customer` 客户
- delivery_type kind：`consulting` 咨询类 / `activity` 活动类 / `circle` 圈子类 / `other` 其他类；status：`active` 有效 / `inactive` 失效
- material kind（K54/K57）：`transcript` 录音文字稿 / `text` 文本资料 / `audio` 音频 / `video` 视频 / `link` 其他链接 / `file` 对象存储
- maintenance kind（K55）：`follow_up` 跟进 / `status_change` 状态变化 / `lead` 线索 / `note` 备注 / `other` 其他

对用户列出结果时用昵称/名称与中文 label，不要甩一堆 id 和 code；需要跟进时再附 id。

## 通用 HTTP（备用，非主路径）

REST 资源路由仍服务 web 管理端。SQL 端点做不到的事（如撤销令牌）可用通用形式：

```bash
python3 "$SKILL_DIR/scripts/gb-crm.py" GET /api/v1/auth/tokens
python3 "$SKILL_DIR/scripts/gb-crm.py" DELETE /api/v1/auth/tokens/3
python3 "$SKILL_DIR/scripts/gb-crm.py" GET /api/v1/customers q=闪光 pageSize=50
```
