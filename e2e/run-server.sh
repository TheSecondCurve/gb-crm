#!/usr/bin/env bash
# e2e 被测服务：种子库 → 生产模式起 api（托管 apps/web/dist）。由 playwright webServer 调用。
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p e2e/.tmp
export NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT=3101 \
  DATABASE_PATH="$PWD/e2e/.tmp/e2e.sqlite" \
  SESSION_SECRET="e2e-session-secret-0123456789abcdef"

pnpm --filter @gb-crm/api exec tsx scripts/e2e-seed.ts
exec pnpm --filter @gb-crm/api start
