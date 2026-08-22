#!/usr/bin/env python3
"""gb-crm HTTP 客户端：从本机凭证发请求，stdout 只打响应 JSON，不打印 token。"""
from __future__ import annotations

import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

CRED_PATH = pathlib.Path.home() / ".gb-crm" / "credentials.json"
LOGIN_HINT = "curl -fsSL {base}/agent/login.sh | sh"


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def load_creds() -> tuple[str, str, str | None]:
    token = os.environ.get("GB_CRM_TOKEN") or ""
    base = (os.environ.get("GB_CRM_BASE_URL") or "").rstrip("/")
    scope = os.environ.get("GB_CRM_SCOPE") or None
    if token and base:
        return base, token, scope
    if not CRED_PATH.is_file():
        die(
            "未找到本机令牌。请先签发（会写入 ~/.gb-crm/credentials.json）：\n"
            "  curl -fsSL http://<crm-host>/agent/login.sh | sh\n"
            "或设置环境变量 GB_CRM_TOKEN 与 GB_CRM_BASE_URL。",
            2,
        )
    try:
        data = json.loads(CRED_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        die(f"无法读取 {CRED_PATH}: {exc}", 2)
    base = base or str(data.get("baseUrl") or "").rstrip("/")
    token = token or str(data.get("token") or "")
    scope = scope or data.get("scope")
    if not base or not token:
        die(f"{CRED_PATH} 缺少 baseUrl 或 token，请重新签发。", 2)
    return base, token, str(scope) if scope else None


def request(method: str, url: str, token: str, body: bytes | None) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            # urllib 默认 UA（Python-urllib/x.y）会被 Cloudflare Bot Fight Mode 拦 1010
            "User-Agent": "gb-crm-agent/1.0",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    # GB_CRM_INSECURE=1：跳过 TLS 证书校验（本机 python 缺 CA 包时的逃生门；
    # 中间人可拿到 token，能修证书就别开）
    handlers: list = [urllib.request.ProxyHandler({})]
    if os.environ.get("GB_CRM_INSECURE") == "1":
        import ssl

        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        return exc.code, raw
    except Exception as exc:
        die(f"无法连接: {exc}")


def parse_args(argv: list[str]) -> tuple[str, str, dict[str, str], str | None]:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        die(
            "用法:\n"
            "  gb-crm.py me\n"
            "  gb-crm.py sql \"SELECT id, nickname FROM customers WHERE deleted_at IS NULL\"\n"
            "  gb-crm.py GET /api/v1/customers q=闪光 pageSize=50\n"
            "  gb-crm.py POST /api/v1/customers --json '{\"nickname\":\"未命名客户\"}'\n"
            "  gb-crm.py PATCH /api/v1/customers/1 --json '{\"nickname\":\"x\",\"updatedAt\":1}'\n"
            "  gb-crm.py DELETE /api/v1/customers/1",
            0 if argv[1:] in (["-h"], ["--help"]) else 2,
        )
    if argv[1].lower() in ("me", "whoami"):
        return "GET", "/api/v1/auth/me", {}, None
    if argv[1].lower() == "sql":
        if len(argv) < 3 or not argv[2].strip():
            die("缺少 SQL。用法: gb-crm.py sql \"SELECT ...\"")
        return "POST", "/api/v1/agent/sql", {}, json.dumps(
            {"sql": argv[2]}, ensure_ascii=False
        )
    method = argv[1].upper()
    if len(argv) < 3:
        die("缺少 PATH。")
    path = argv[2]
    if not path.startswith("/"):
        die("PATH 必须以 / 开头，例如 /api/v1/customers")
    query: dict[str, str] = {}
    payload: str | None = None
    rest = argv[3:]
    i = 0
    while i < len(rest):
        arg = rest[i]
        if arg in ("--json", "-d"):
            if i + 1 >= len(rest):
                die("--json 后面需要一段 JSON")
            payload = rest[i + 1]
            i += 2
            continue
        if "=" not in arg or arg.startswith("-"):
            die(f"无法解析参数: {arg}（查询用 key=value，body 用 --json '{{...}}'）")
        k, _, v = arg.partition("=")
        query[k] = v
        i += 1
    return method, path, query, payload


def main() -> None:
    method, path, query, payload = parse_args(sys.argv)
    base, token, _scope = load_creds()
    url = base + path
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
    body = None
    if payload is not None:
        try:
            json.loads(payload)
        except json.JSONDecodeError as exc:
            die(f"--json 不是合法 JSON: {exc}")
        body = payload.encode("utf-8")
    status, text = request(method, url, token, body)
    print(f"HTTP {status}", file=sys.stderr)
    if status == 401:
        print(
            f"令牌无效或已过期。请重新签发（不要把密码发给我）：\n  {LOGIN_HINT.format(base=base)}",
            file=sys.stderr,
        )
    if text:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
    raise SystemExit(0 if 200 <= status < 300 else 1)


if __name__ == "__main__":
    main()
