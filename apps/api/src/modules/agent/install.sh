#!/bin/sh
# gb-crm skill 安装器（渠道 A，由 CRM 服务器 /agent/skill/gb-crm/install.sh 下发，仅需内网、不需 GitHub）。
# 步骤：探测 AGENT 技能目录 → 下载 SKILL.md + scripts/gb-crm.py → 引导授权（用户名/密码 → PAT）。
# 安全：skill 不含任何密钥；凭证只写入 ~/.gb-crm/credentials.json(600)；密码只在你的终端里输入。
set -eu

BASE="__GB_CRM_BASE_URL__"
BASE="${BASE%/}"
SKILL_BASE="$BASE/agent/skill/gb-crm"

if ! command -v python3 >/dev/null 2>&1; then
  echo "缺少 python3。本 skill 需要 python3（macOS 自带；Linux 请安装 python3）。" >&2
  exit 1
fi

choose_dir() {
  # 项目级 .agents/skills 优先（跟在项目里用这本 AGENT 一致），否则用户级
  if [ -d "./.agents/skills" ]; then echo "./.agents/skills"; return; fi
  for d in "$HOME/.agents/skills" "$HOME/.codex/skills" "$HOME/.claude/skills" "$HOME/.cursor/skills"; do
    if [ -d "$d" ]; then echo "$d"; return; fi
  done
  echo "$HOME/.agents/skills"
}

DIR="$(choose_dir)"
TARGET="$DIR/gb-crm"
mkdir -p "$TARGET/scripts"

echo "从 $BASE 下载 skill 文件到 $TARGET ..."
curl -fsSL "$SKILL_BASE/SKILL.md" -o "$TARGET/SKILL.md"
curl -fsSL "$SKILL_BASE/scripts/gb-crm.py" -o "$TARGET/scripts/gb-crm.py"
chmod +x "$TARGET/scripts/gb-crm.py"
echo "skill 已安装：$TARGET"

# 授权决策：SKIP_LOGIN=1 显式跳过；FORCE_LOGIN=1 强制重签；否则已有本机凭证则跳过（更新无需重复授权）。
CRED="$HOME/.gb-crm/credentials.json"
skip_login=false
if [ "${GB_CRM_SKIP_LOGIN:-0}" = "1" ]; then skip_login=true
elif [ "${GB_CRM_FORCE_LOGIN:-0}" = "1" ]; then skip_login=false
elif [ -f "$CRED" ]; then skip_login=true
fi

if [ "$skip_login" = true ]; then
  if [ "${GB_CRM_SKIP_LOGIN:-0}" = "1" ]; then
    echo "已按 GB_CRM_SKIP_LOGIN=1 跳过授权。之后请自行运行：curl -fsSL $BASE/agent/login.sh | sh"
  else
    echo "已检测到本机凭证 $CRED，跳过授权（更新无需重发令牌）。如需重新授权：设置 GB_CRM_FORCE_LOGIN=1 或删除 $CRED 后重跑。"
  fi
  exit 0
fi

echo "接下来在 CRM 授权（输入用户名/密码），以领取本机可用的访问令牌："
tmp="$(mktemp)"
curl -fsSL "$BASE/agent/login.sh" -o "$tmp"
sh "$tmp"
rm -f "$tmp"

echo "完成。现在可验证：python3 \"$TARGET/scripts/gb-crm.py\" me"
echo "提示：不要把 ~/.gb-crm/credentials.json 的内容发给任何人 / 不要写进对话。"
