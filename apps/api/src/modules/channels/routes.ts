// /api/v1/channels 路由（§3：routes 只做 Zod、requireCan、HTTP 映射，不写 SQL）。
// K27：PATCH 含任一密钥键（CHANNEL_SECRET_KEYS）时再加 channels.updateChannelSecrets 门槛
// （body 预检，对齐 users 的 updateRole 模式）；GET list/one 按 readChannelSecrets 决定是否置 null。
import {
  can,
  CHANNEL_SECRET_KEYS,
  channelListQuerySchema,
  channelPatchSchema,
  channelWriteSchema,
} from "@gb-crm/shared";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { forbidden } from "../../plugins/error-handler.js";
import { requireCan } from "../../plugins/rbac.js";
import {
  createChannel,
  deleteChannel,
  getChannelResult,
  listChannelsResult,
  patchChannel,
} from "./service.js";

export interface ChannelsRoutesOptions {
  db: Db;
  /** 时钟注入（epoch 毫秒） */
  now: () => number;
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** PATCH 含任一密钥键 → 还需 channels.updateChannelSecrets（矩阵：assistant ✗） */
const requireUpdateSecretsWhenSecretKeys: preHandlerHookHandler = async (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (CHANNEL_SECRET_KEYS.some((key) => key in body)) {
    if (!can(req.user?.systemRole ?? null, "channels", "updateChannelSecrets")) throw forbidden();
  }
};

export function channelsRoutes(app: FastifyInstance, opts: ChannelsRoutesOptions): void {
  const { db, now } = opts;
  const auditCtx = (req: { user: { id: number } | null }) => ({
    now: now(),
    userId: req.user!.id, // requireCan 已保证非空
  });
  // K27：assistant 无 readChannelSecrets → GET/PATCH 响应密钥字段置 null
  const canSeeSecrets = (req: FastifyRequest) =>
    can(req.user?.systemRole ?? null, "channels", "readChannelSecrets");

  app.get("/api/v1/channels", { preHandler: requireCan("channels", "list") }, async (req) => {
    const query = channelListQuerySchema.parse(req.query ?? {});
    const { data, total } = listChannelsResult(db, query, canSeeSecrets(req));
    return { data, meta: listMeta(query.page, query.pageSize, total) };
  });

  app.post(
    "/api/v1/channels",
    { preHandler: requireCan("channels", "create") },
    async (req, reply) => {
      const body = channelWriteSchema.parse(req.body ?? {});
      const data = createChannel(db, body, auditCtx(req));
      return reply.code(201).send({ data });
    },
  );

  app.get("/api/v1/channels/:id", { preHandler: requireCan("channels", "read") }, async (req) => {
    const { id } = idParamSchema.parse(req.params);
    return { data: getChannelResult(db, id, canSeeSecrets(req)) };
  });

  app.patch(
    "/api/v1/channels/:id",
    { preHandler: [requireCan("channels", "update"), requireUpdateSecretsWhenSecretKeys] },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = channelPatchSchema.parse(req.body ?? {});
      return { data: patchChannel(db, id, patch, auditCtx(req), canSeeSecrets(req)) };
    },
  );

  app.delete(
    "/api/v1/channels/:id",
    { preHandler: requireCan("channels", "delete") },
    async (req, reply) => {
      const { id } = idParamSchema.parse(req.params);
      deleteChannel(db, id, auditCtx(req));
      return reply.code(204).send();
    },
  );
}
