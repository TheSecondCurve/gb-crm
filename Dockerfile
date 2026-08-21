# syntax=docker/dockerfile:1
# gb-crm 内网单进程镜像（K32）：Fastify 托管 /api + apps/web/dist（SPA fallback，K20）。
# SQLite 只走 named volume，不 COPY 进镜像；.env / data/ / *.sqlite 由 .dockerignore 排除。
#
# 运行方式：API 以 tsx 直接跑 TS 源码（packages/shared 的 exports 指向 src/*.ts，无构建产物），
# 因此 tsx 是 @gb-crm/api 的运行时依赖；web 在 build 阶段产出静态 dist。

# ---- deps：完整依赖（含 devDeps，供 web 构建）----
# 用完整版 bookworm（自带 python3/make/g++）：better-sqlite3 在本阶段跑 install 脚本，
# 官方镜像 glibc 足够新，prebuild 可直接用；即使要回退 node-gyp 编译也有工具链。
FROM node:24-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci

# ---- prod-deps：仅生产依赖（runtime 阶段的 node_modules 来源）----
FROM node:24-bookworm AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev

# ---- build：web 静态产物 ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @gb-crm/web

# ---- runtime：只 COPY 运行必需 ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATABASE_PATH=/data/gb-crm.sqlite
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
# npm workspaces 默认提升到根 node_modules；workspace 包内可能还有 symlink / 未提升依赖
COPY --from=prod-deps /app/node_modules ./node_modules
COPY apps/api/src ./apps/api/src
COPY apps/api/drizzle ./apps/api/drizzle
COPY packages/shared/src ./packages/shared/src
COPY --from=build /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3001
CMD ["npm", "start", "-w", "@gb-crm/api"]
