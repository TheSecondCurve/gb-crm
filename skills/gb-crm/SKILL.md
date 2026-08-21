---
name: gb-crm
description: >
  闪光 · 客户运营（gb-crm）本机 HTTP 客户端。用 ~/.gb-crm/credentials.json 的 PAT
  查询或维护客户、渠道、产品、团队成员。当用户提到 CRM、客户名单、渠道资产、产品目录、
  团队成员、gb-crm、闪光客户运营，或要查/改客户时使用。Use when the user runs /gb-crm.
metadata:
  short-description: 用本机 PAT 调用 gb-crm REST
  compatibility: Requires python3
---

# gb-crm

品牌文案锁定 **「闪光 · 客户运营」**，禁止「女商」。

`SKILL_DIR` = 本文件所在目录。所有 HTTP **只**走脚本，不要自己拼 `Authorization`，不要 Read `~/.gb-crm/credentials.json`，不要把 token / 密码写进对话或命令行。

```bash
python3 "$SKILL_DIR/scripts/gb-crm.py" me
python3 "$SKILL_DIR/scripts/gb-crm.py" GET /api/v1/customers q=闪光 pageSize=50
python3 "$SKILL_DIR/scripts/gb-crm.py" POST /api/v1/customers --json '{"nickname":"未命名客户"}'
python3 "$SKILL_DIR/scripts/gb-crm.py" PATCH /api/v1/customers/12 --json '{"nickname":"新","updatedAt":1774}'
python3 "$SKILL_DIR/scripts/gb-crm.py" DELETE /api/v1/customers/12
```

凭证查找：`GB_CRM_TOKEN` + `GB_CRM_BASE_URL`，否则 `~/.gb-crm/credentials.json`。没有文件 → 让用户**自己**在终端跑（你不要代收密码）：

```bash
curl -fsSL http://<crm-host>/agent/login.sh | sh
```

本仓库本地开发默认 `http://127.0.0.1:3001`。脚本 stderr 第一行是 `HTTP <status>`；401 时提示重新签发。

## 工作方式

1. 先 `me`，记下 `systemRole`。再看凭证文件里的 `scope`（`read` / `write`）；read 只能 GET。
2. 查数据：列表 `q` + `page` + `pageSize`（默认 25，最大 100）。要全量就翻页直到 `meta.page * pageSize >= meta.total`。
3. 改数据：用户明确要求才写。先 GET 该行，PATCH **必须带**上次的 `updatedAt`。删除前复述将删的行并得到确认。
4. 错误信封 `{ error: { code, message, details? } }`，`message` 中文可直接告诉用户。403 不要换字段重试同一越权操作。409 用响应里的当前行，丢掉这次 PATCH。
5. JSON camelCase；时间 epoch 毫秒；金额 `priceCents` 整数分，展示元。不要 `yuan * 100` 不 round 就写入。
6. 删除 = 软删。助手看不到渠道密钥字段（GET 为 null），也不能 PATCH 那些键。

## 资源

| 资源 | 列表过滤 | 备注 |
| --- | --- | --- |
| `/api/v1/customers` | `q` `customerType` `tag` `ownerId` `channelId` `sort=updatedAt\|createdAt\|nickname` | 创建默认昵称「未命名客户」。`ownerIds` / `upsellOwnerIds` 助手不可改 |
| `/api/v1/channels` | `q` `platform` `channelType` `accountType` `status` `sort=updatedAt\|createdAt\|name` | 密钥：`accountId` `registerPhone` `registrant` `realNamePerson` `loginDevice` |
| `/api/v1/products` | `q` `productType` `status` `isPackage=true\|false` `sort=updatedAt\|createdAt\|name\|priceCents` | 助手只读 |
| `/api/v1/users` | `q` `systemRole` `accountStatus` `employmentStatus` `jobTitle` | 助手不可见；永不出现 `passwordHash` |

`q` 按空白切词，词 AND、字段 OR。`order=asc|desc`。关系数组：键缺席不动，`[]` 清空。`parentId` 拒绝自指、环、深度 > 2。

写权限（403 为准）：admin 全开；operator 不能写 users / 设角色 / 设他人密码；assistant 不能建客户、不能改归属人/升单人、不能写产品、不能碰渠道密钥。

## 枚举（请求用 code，对用户说中文）

完整表在 `packages/shared/src/labels.ts`。常用：

- 角色 `admin` 管理员 / `operator` 团队运营 / `assistant` 兼职助手
- 客户类型 `guest` 嘉宾 / `customer` 客户 / `company` 企业 / `invite` 邀请 / `partner` 合作伙伴
- 标签 `stage_0_1` `stage_1_10` `stage_10_100` `vip` `ip` `side_hustle` `guest` `partner`
- 产品状态 `on_sale` 在售 / `off_sale` 停售 / `in_dev` 开发中；价格展示「199 元」← `priceCents=19900`
- 渠道状态 `operating` 运营中 / `paused` 暂停 / `pending` 待开通

对用户列出结果时用昵称/名称，不要甩一堆 id；需要跟进时再附 id。
