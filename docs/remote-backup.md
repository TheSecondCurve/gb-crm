# 远程备份配置指南（Cloudflare R2）

> 适用对象：系统管理员。目标：给 gb-crm 配一个 S3 兼容的远程对象存储，让每日数据库备份自动上传到云端（滚动保留 N 份）。以 **Cloudflare R2** 为例——免费额度充足、无流量费；其它 S3 兼容服务商见文末对照表。

## 0. 功能是怎么工作的

- 备份 = 后台任务 `db-backup`（可手动触发，也可由「定时任务」按 cron 调度）。
- 每次备份先落**本地** `<数据库目录>/backups/gb-crm-<时间戳>.sqlite.gz`（滚动保留 7 份），然后若「远程备份」配置为启用且完整，自动上传到远端：

  ```
  {路径前缀}gb-crm-<时间戳>.sqlite.gz   ← 时间戳版本，滚动保留 N 份（可配，默认 7）
  {路径前缀}gb-crm-latest.sqlite.gz     ← 最新指针，每次覆盖，方便一键恢复
  ```

  远端与本地同为时间戳命名、字典序即时间序，超出 N 份自动删除最旧（仅删匹配 `gb-crm-YYYYMMDD-HHmmss-SSS.sqlite.gz` 的对象，`latest` 永不计入滚动）。

- 上传失败时任务标记为「部分失败」，错误原因可在后台任务详情里看到，**不影响**已成功的本地备份；远端修剪（LIST/DELETE）失败仅记录 `pruneError`，上传成功仍视为成功。
- 未启用 / 配置残缺时静默跳过上传，行为与从前一致。

## 1. 申请 Cloudflare 并开通 R2

1. 注册并登录 Cloudflare 控制台：<https://dash.cloudflare.com/>（免费账户即可）。
2. 左侧菜单进入 **Storage & databases → R2**。
3. 首次使用需**开通 R2 服务**：按提示购买 R2 计划（需要绑定一张信用卡或 PayPal）。
   - 有免费额度，日常备份用不完：约 10 GB 存储/月 + 百万级写操作/月，且**出口流量免费**；
   - 具体额度与价格以官方定价页为准：<https://developers.cloudflare.com/r2/pricing/>。
   - CRM 的 SQLite 库 gzip 后通常只有 MB 级，每天一次全量覆盖上传基本永远落在免费额度内。

## 2. 创建存储桶（Bucket）

1. 在 R2 页面选择 **Create bucket**。
2. 名称：如 `gb-crm-backup`（小写字母、数字、连字符）。
3. Location：选 **Automatic** 即可（在意延迟可选 APAC）；Storage class 保持默认 Standard。
4. 记住这个名称，后面要填。

## 3. 生成 S3 API 凭证（Access Key）

R2 不用账号密码访问，而是生成一对 S3 API Key：

1. 回到 **R2 Overview** 页，在右侧 **Account Details** 区域找到 **API Tokens**，点旁边的 **Manage**。
2. 选 **Create Account API token**（或 User API token 均可）。
3. 权限选 **Object Read & Write**，范围选 **Apply to specific buckets only**，只勾选 `gb-crm-backup`（最小权限原则）。
4. 点 **Create API Token**。创建成功页会显示三样东西，全部记下来：

| 项目 | 示例 | 用途 |
| --- | --- | --- |
| Access Key ID | `a1b2c3…` | 配置页「AccessKeyId」 |
| Secret Access Key | `长随机串` | 配置页「SecretAccessKey」。**只显示这一次**，关掉就看不到了 |
| S3 Endpoint | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | 配置页「Endpoint」（创建页底部或 R2 Overview 页可见，`ACCOUNT_ID` 就是你的 Cloudflare 账户 ID） |

> 若你的桶建在 EU 等 jurisdiction 下，endpoint 会带区域后缀（如 `.eu.r2.cloudflarestorage.com`），照抄面板给出的即可。

## 4. 在管理端填写配置

登录 gb-crm 管理端（admin 账号）→ **系统设置 → 远程备份**：

| 字段 | 填什么 |
| --- | --- |
| 启用远程上传 | ☑️ 勾上 |
| Endpoint | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`（第 3 步抄来的） |
| Region | `auto` |
| Bucket | `gb-crm-backup` |
| 路径前缀 | 可空；想归整就填 `backups/`（结尾斜杠会自动归一化，最终对象为 `backups/gb-crm-latest.sqlite.gz`） |
| AccessKeyId | 第 3 步的 Access Key ID |
| SecretAccessKey | 第 3 步的 Secret Access Key |
| 远端保留份数（N） | 1~30，默认 7。远端时间戳版本滚动保留 N 份，超出删最旧；`latest` 始终覆盖保留 |

然后：

1. 点 **测试连接** —— 成功会提示探针对象已写入并删除；失败会把服务端返回的错误原文 Toast 出来（多为 key 错、权限不足、endpoint 抄错）。
2. 点 **保存配置**。SecretAccessKey 只回显掩码，之后留空即表示「不修改」。

## 5. 启用每日自动备份

配置只是「存好了」，还要让备份定时跑起来：

1. 进入 **系统设置 → 定时任务**，新建调度：
   - 类型：**数据库备份**
   - cron：如 `30 3 * * *`（5 字段，按服务器本地时区；生产容器默认 `TZ=Asia/Shanghai`，即每天凌晨 03:30）
   - enabled：开
2. 想立刻验证一次：在该调度行点 **立即执行**（不会推进下次计划时间）。
3. 到 **系统设置 → 后台任务** 查看结果：
   - 「成功」= 本地 + 远端都完成；
   - 「部分失败」= 本地成功但**上传远端失败**，详情里有具体原因（网络不通、凭证失效等），修复后重跑即可。

## 6. 怎么恢复数据

远端有 `N` 份时间戳版本 + 1 个最新指针，恢复思路是「下载 → 解压 → 替换库文件」：

```bash
# 1) 下载（任选一种 S3 工具）——最新指针
aws s3 cp s3://gb-crm-backup/backups/gb-crm-latest.sqlite.gz ./ \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto

# 1b) 或按时间挑选历史版本（列出桶内对象）
aws s3 ls s3://gb-crm-backup/backups/ --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com --region auto
# 形如 backups/gb-crm-20260827-033000-123.sqlite.gz
aws s3 cp s3://gb-crm-backup/backups/gb-crm-20260827-033000-123.sqlite.gz ./ \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com --region auto

# 2) 解压成标准 SQLite 文件
gunzip gb-crm-latest.sqlite.gz        # 得到 gb-crm-latest.sqlite

# 3) 校验能打开
sqlite3 gb-crm-latest.sqlite ".tables"

# 4) 停掉 gb-crm 容器/进程，用它替换 volume 里的库文件，再启动
#    注意权限：chmod 600，属主与原库文件一致
```

也可以直接用服务器上的本地备份（`<数据库目录>/backups/` 内保留最近 7 份），不一定非要走远端。

## 7. 安全注意事项

- API Token 权限已限定为**仅该桶读写**；若怀疑泄露，去 Cloudflare 同一页面 **Revoke** 后重新生成，再更新配置页即可。
- SecretAccessKey 明文存于本机 SQLite（库文件 chmod 600 + 仅内网），接口永远只回掩码，日志不含明文。
- 远端对象含全量客户数据：Cloudflare 账号本身务必开启强密码 / 两步验证。
- 想清空远端：删掉桶里 `{前缀}gb-crm-latest.sqlite.gz` + `{前缀}gb-crm-*.sqlite.gz` 即可，下次备份会重新生成。
- 远端滚动依赖 `ListObjectsV2 + DeleteObject` 权限（与上传同为读写权限）；修剪失败不影响已上传的备份，仅在任务 `result.remote.pruneError` 中记录。

## 附：其它 S3 兼容服务商字段对照

实现是标准 AWS SigV4 + path-style，以下服务商同样适用：

| 服务商 | Endpoint 形态 | Region |
| --- | --- | --- |
| AWS S3 | `https://s3.<region>.amazonaws.com` | 如 `ap-east-1` |
| MinIO（自建） | `http://minio.internal:9000` | 随意，如 `us-east-1` |
| 阿里云 OSS | `https://oss-cn-hangzhou.aliyuncs.com` | `oss-cn-hangzhou` |
| 腾讯云 COS | `https://cos.ap-guangzhou.myqcloud.com` | `ap-guangzhou` |

Bucket 需要在对应控制台预先创建，并在其密钥管理里拿到 AccessKeyId / SecretAccessKey；填法与上文完全相同。
