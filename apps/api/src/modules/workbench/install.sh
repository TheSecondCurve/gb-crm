#!/bin/sh
# gb-content 工作台安装器（K61，由 CRM 服务器 /agent/workbench/install.sh 下发，仅需内网）。
# 给不碰 git 的成员一键装机：授权（复用 gb-crm 的 ~/.gb-crm/credentials.json，没有就现签）
# → 拉最新快照 manifest → 逐文件下载 + sha256 校验 → 写入目标目录。
# 之后日常更新不再跑本脚本，运行 <目标目录>/_工作区仓库/脚本/sync.sh 即可（或对电脑上的
# agent 说「同步工作台」）。重跑本脚本 = 强制重装到最新版（本地改动会被覆盖）。
# 安全：凭证只存在于 ~/.gb-crm/credentials.json(600)；本脚本不含任何密钥。
# 只用 set -e（下载失败即中止）；不用 set -u：macOS /bin/sh（bash 3.2）的 nounset 在不同
# shell 变体间行为不一（同 k35 渠道A 安装器结论）。
set -e

BASE="__GB_CRM_BASE_URL__"
BASE="${BASE%/}"
API="$BASE/api/v1/workbench"
CRED="$HOME/.gb-crm/credentials.json"

# 目标目录：第一个参数 > GB_WORKBENCH_DIR > 默认 ~/gb-content
TARGET="${1:-${GB_WORKBENCH_DIR:-$HOME/gb-content}}"

command -v curl >/dev/null 2>&1 || { echo "缺少 curl，请先安装。" >&2; exit 1; }
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "缺少 shasum / sha256sum（校验快照必需）。" >&2
  exit 1
fi

if [ -e "$TARGET/.git" ]; then
  echo "$TARGET 是 git 仓库（开发机工作副本），成员不应把快照装进它。" >&2
  exit 1
fi

# 授权决策：SKIP_LOGIN=1 显式跳过；FORCE_LOGIN=1 强制重签；否则已有本机凭证则跳过。
skip_login=false
if [ "${GB_CRM_SKIP_LOGIN:-0}" = "1" ]; then skip_login=true
elif [ "${GB_CRM_FORCE_LOGIN:-0}" = "1" ]; then skip_login=false
elif [ -f "$CRED" ]; then skip_login=true
fi

if [ "$skip_login" = false ]; then
  echo "接下来在 CRM 授权（输入用户名/密码），以领取本机可用的访问令牌："
  tmp="$(mktemp)"
  curl -fsSL "$BASE/agent/login.sh" -o "$tmp"
  sh "$tmp"
  rm -f "$tmp"
fi

if [ ! -f "$CRED" ]; then
  echo "缺少 $CRED，授权未完成；重跑本脚本或：curl -fsSL $BASE/agent/login.sh | sh" >&2
  exit 1
fi

# 提取 token：login.sh 写的是固定格式 JSON（indent=2），按行 sed 提取。
# 只在本脚本内使用；不要把它的内容回显或写进别的文件。
TOKEN="$(sed -n 's/^  "token": "\(.*\)",$/\1/p' "$CRED" | head -1)"
if [ -z "$TOKEN" ]; then
  echo "无法从 $CRED 读出 token（格式变了？）请重新授权：curl -fsSL $BASE/agent/login.sh | sh" >&2
  exit 1
fi
AUTH="Authorization: Bearer $TOKEN"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "从 $BASE 拉取最新清单 ..."
if ! curl -fsSL -H "$AUTH" "$API/manifest.tsv" -o "$WORK/manifest.tsv"; then
  echo "拉取清单失败：检查网络，或凭证是否仍有效（401 时重新跑 login.sh）。" >&2
  exit 1
fi

VER="$(awk -F'\t' '$1 == "#version" { print $2; exit }' "$WORK/manifest.tsv")"
SUBJECT="$(awk -F'\t' '$1 == "#subject" { print $2; exit }' "$WORK/manifest.tsv")"
if [ -z "$VER" ]; then
  echo "清单里没有版本信息（服务器还没有任何发布版本？）" >&2
  exit 1
fi
echo "最新版本 v$VER${SUBJECT:+（$SUBJECT）}，开始下载文件 ..."

grep -v '^#' "$WORK/manifest.tsv" > "$WORK/data.tsv"

hash_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 < "$1" | cut -d' ' -f1
  else sha256sum < "$1" | cut -d' ' -f1; fi
}

mkdir -p "$TARGET"
COUNT=0
FAIL=0
TAB="$(printf '\t')"
while IFS="$TAB" read -r sha size mode path; do
  case "$sha" in ""|*[!0-9a-f]*) echo "清单行格式异常：$path" >&2; FAIL=$((FAIL+1)); continue ;; esac
  [ -n "$path" ] || { echo "清单行缺路径" >&2; FAIL=$((FAIL+1)); continue; }
  COUNT=$((COUNT+1))
  dest="$TARGET/$path"
  mkdir -p "$(dirname "$dest")"
  if ! curl -fsSL -H "$AUTH" "$API/objects/$sha" -o "$WORK/obj"; then
    echo "✗ 下载失败：$path" >&2
    FAIL=$((FAIL+1))
    continue
  fi
  got="$(hash_of "$WORK/obj")"
  if [ "$got" != "$sha" ]; then
    echo "✗ 校验不符：$path（请重跑）" >&2
    FAIL=$((FAIL+1))
    continue
  fi
  mv -f "$WORK/obj" "$dest"
  if [ "$mode" = "493" ]; then chmod 755 "$dest"; else chmod 644 "$dest"; fi
done < "$WORK/data.tsv"

if [ "$FAIL" -gt 0 ]; then
  echo "完成 $((COUNT-FAIL))/$COUNT，$FAIL 个文件失败；直接重跑本脚本即可续装。" >&2
  exit 1
fi

mkdir -p "$TARGET/.gb-workbench"
cp "$WORK/data.tsv" "$TARGET/.gb-workbench/manifest.tsv"
printf '%s\n' "$VER" > "$TARGET/.gb-workbench/version"

echo ""
echo "安装完成：v$VER，共 $COUNT 个文件 → $TARGET"
echo "日常更新：sh \"$TARGET/_工作区仓库/脚本/sync.sh\"（或对电脑上的 agent 说「同步工作台」）"
echo "提示：不要把 ~/.gb-crm/credentials.json 的内容发给任何人 / 不要写进对话。"
