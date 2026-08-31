#!/bin/sh
# gb-crm agent 登录：用已有用户名密码签发个人令牌，写入 ~/.gb-crm/credentials.json
#
# 无需克隆仓库：
#   curl -fsSL http://<crm-host>/agent/login.sh | sh
#
# 非交互（无 TTY / CI）：
#   GB_CRM_USERNAME=alice GB_CRM_PASSWORD='***' GB_CRM_SCOPE=read sh login.sh
#
# 覆盖签发地址：
#   GB_CRM_BASE_URL=http://127.0.0.1:3001
#
# 密码不落盘、不进脚本参数列表以外的文件；token 不打印到 stdout。
# 只用 set -e；不用 set -u：macOS /bin/sh（bash 3.2）的 nounset 在不同 shell 变体间行为不一致。

set -e

BASE_URL="${GB_CRM_BASE_URL:-__GB_CRM_BASE_URL__}"
BASE_URL="${BASE_URL%/}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "需要 python3（macOS 自带）来编码 JSON 并签发令牌。" >&2
  exit 1
fi

prompt_tty() {
  # $1 prompt  $2 silent(0/1)
  printf "%s" "$1" > /dev/tty
  if [ "$2" = "1" ]; then
    stty -echo < /dev/tty
    # 无论成功失败都恢复 echo
    # shellcheck disable=SC2064
    trap 'stty echo < /dev/tty 2>/dev/null || true' EXIT
    IFS= read -r _GB_PROMPT_VAL < /dev/tty
    stty echo < /dev/tty
    trap - EXIT
    printf "\n" > /dev/tty
  else
    IFS= read -r _GB_PROMPT_VAL < /dev/tty
  fi
}

if [ -n "${GB_CRM_USERNAME:-}" ]; then
  USERNAME="$GB_CRM_USERNAME"
elif [ -e /dev/tty ]; then
  prompt_tty "用户名: " 0
  USERNAME="$_GB_PROMPT_VAL"
else
  echo "请设置 GB_CRM_USERNAME，或在终端运行以便交互输入。" >&2
  exit 1
fi

if [ -n "${GB_CRM_PASSWORD:-}" ]; then
  PASSWORD="$GB_CRM_PASSWORD"
elif [ -e /dev/tty ]; then
  prompt_tty "密码: " 1
  PASSWORD="$_GB_PROMPT_VAL"
else
  echo "请设置 GB_CRM_PASSWORD，或在终端运行以便交互输入。" >&2
  exit 1
fi

if [ -n "${GB_CRM_SCOPE:-}" ]; then
  SCOPE="$GB_CRM_SCOPE"
elif [ -e /dev/tty ]; then
  prompt_tty "范围 read / write [read]: " 0
  SCOPE="${_GB_PROMPT_VAL:-read}"
else
  SCOPE="read"
fi

case "$SCOPE" in
  read|write) ;;
  *)
    echo "范围必须是 read 或 write。" >&2
    exit 1
    ;;
esac

if [ -n "${GB_CRM_TOKEN_NAME:-}" ]; then
  TOKEN_NAME="$GB_CRM_TOKEN_NAME"
else
  TOKEN_NAME="$(uname -n 2>/dev/null || echo agent)"
fi

export GB_CRM_BASE_URL="$BASE_URL"
export GB_CRM_USERNAME="$USERNAME"
export GB_CRM_PASSWORD="$PASSWORD"
export GB_CRM_SCOPE="$SCOPE"
export GB_CRM_TOKEN_NAME="$TOKEN_NAME"

python3 - <<'PY'
import json
import os
import pathlib
import ssl
import sys
import urllib.error
import urllib.request

base = os.environ["GB_CRM_BASE_URL"].rstrip("/")
username = os.environ["GB_CRM_USERNAME"]
password = os.environ["GB_CRM_PASSWORD"]
scope = os.environ["GB_CRM_SCOPE"]
name = os.environ.get("GB_CRM_TOKEN_NAME") or "agent"
home = os.environ["HOME"]

body = json.dumps(
    {"username": username, "password": password, "scope": scope, "name": name},
    ensure_ascii=False,
).encode("utf-8")
req = urllib.request.Request(
    base + "/api/v1/auth/tokens",
    data=body,
    method="POST",
    headers={
        "Content-Type": "application/json",
        "Accept": "application/json",
        # urllib 默认 UA（Python-urllib/x.y）会被 Cloudflare Bot Fight Mode 拦 1010
        "User-Agent": "gb-crm-agent/1.0",
    },
)
# 内网/本机签发不走 http_proxy，否则 localhost 会被代理转走并挂起
handlers = [urllib.request.ProxyHandler({})]
# GB_CRM_INSECURE=1：跳过 TLS 证书校验（本机 python 缺 CA 包时的逃生门；
# 明文风险自担——中间人可拿到密码与 token，能修证书就别开）
if os.environ.get("GB_CRM_INSECURE") == "1":
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    handlers.append(urllib.request.HTTPSHandler(context=ctx))
    print("警告: GB_CRM_INSECURE=1，已跳过 TLS 证书校验。", file=sys.stderr)
opener = urllib.request.build_opener(*handlers)
try:
    with opener.open(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
except urllib.error.HTTPError as exc:
    raw = exc.read().decode("utf-8", "replace")
    try:
        msg = json.loads(raw)["error"]["message"]
    except Exception:
        msg = raw or str(exc)
    print(msg, file=sys.stderr)
    sys.exit(1)
except Exception as exc:
    print(f"无法连接 {base}: {exc}", file=sys.stderr)
    sys.exit(1)

data = payload.get("data") or {}
token = data.get("token")
if not token:
    print("签发响应缺少 token", file=sys.stderr)
    sys.exit(1)

cred_dir = pathlib.Path(home) / ".gb-crm"
cred_dir.mkdir(parents=True, exist_ok=True)
os.chmod(cred_dir, 0o700)
cred = {
    "baseUrl": base,
    "token": token,
    "scope": data.get("scope", scope),
    "username": username,
}
tmp = cred_dir / "credentials.json.tmp"
final = cred_dir / "credentials.json"
tmp.write_text(json.dumps(cred, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(tmp, 0o600)
tmp.replace(final)
os.chmod(final, 0o600)
print(f"已写入 {final} （权限 600）")
print(f"范围: {cred['scope']}  前缀: {data.get('prefix', '')}")
print("请不要把 token 发给别人或写进 git。之后 skill 会读取该文件。")
PY
