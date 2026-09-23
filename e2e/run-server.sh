#!/usr/bin/env bash
# e2e 被测服务：种子库 → 生产模式起 api（托管 apps/web/dist）+ 桩 S3（K57 资料上传）。
# 由 playwright webServer 调用；桩 S3 与 api 同进程组，任一首出即整组退出。
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p e2e/.tmp
rm -rf e2e/.tmp/s3   # 桩对象存储每次重置，保证用例可重复
export NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT=3101 \
  DATABASE_PATH="$PWD/e2e/.tmp/e2e.sqlite" \
  SESSION_SECRET="e2e-session-secret-0123456789abcdef" \
  LOGIN_RATE_LIMIT_MAX=1000

node e2e/stub-s3.mjs &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT

npm run e2e:seed -w @gb-crm/api
exec npm start -w @gb-crm/api
