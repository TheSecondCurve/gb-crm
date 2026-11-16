// K68 语料同步端点（/api/v1/corpus/**，面向外部大脑的拉模式变更流）。
// - GET /documents：全量（updatedSince 缺席，仅 live）或增量（live 更新行 + 墓碑行），
//   默认 updated_at 升序排空，meta.nextSince = 本页最大 updatedAt 供下次接力；
// - GET /documents/:id：单条补拉（恒带 content；软删 / 非文本 → 404）；
// - GET /head：水位探针（latestUpdatedAt / liveDocuments），消费方可先探后拉。
// 认证复用 K35 PAT：corpus scope 令牌（永不过期，session-auth 已钉死只到本模块）直接放行；
// 其余身份（cookie / read PAT）走 materials 读权限——不新开 ACL 资源。
import { corpusDocumentsQuerySchema } from "@gb-crm/shared";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { Db } from "../../db/client.js";
import { listMeta } from "../../lib/pagination.js";
import { notFound } from "../../plugins/error-handler.js";
import { requireCan } from "../../plugins/rbac.js";
import type { CustomerRef } from "../deliveries/assemble.js";
import {
  assembleMaterialDetail,
  assembleMaterialDetails,
  type MaterialDeliveryRef,
  type MaterialDetailDto,
} from "../materials/assemble.js";
import { findLiveMaterialTagIdsByNames } from "../materials/repo.js";
import { corpusHeadState, getCorpusDocumentRow, listCorpusDocuments } from "./repo.js";

export interface CorpusRoutesOptions {
  db: Db;
}

/** corpus scope 令牌直接放行；其余身份要求 materials 读权限 */
const requireCorpusAccess: preHandlerHookHandler = async (req, reply) => {
  if (req.tokenScope === "corpus") return;
  await requireCan("materials", "read")(req, reply);
};

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

/** 对外语料文档 DTO：MaterialDetailDto 的稳定投影（不含内部用户名/归档/AI 元数据） */
export interface CorpusDocumentDto {
  id: number;
  deleted: false;
  kind: string;
  title: string;
  description: string | null;
  contentLength: number;
  /** 仅 include=content（或单条端点）携带；否则 null */
  content: string | null;
  tags: { id: number; name: string }[];
  customers: CustomerRef[];
  delivery: MaterialDeliveryRef | null;
  createdAt: number;
  updatedAt: number;
}

/** 墓碑：软删语料的占位行，消费方按 id 从索引移除 */
export interface CorpusTombstoneDto {
  id: number;
  deleted: true;
  updatedAt: number;
}

function toCorpusDocument(dto: MaterialDetailDto, includeContent: boolean): CorpusDocumentDto {
  return {
    id: dto.id,
    deleted: false,
    kind: dto.kind,
    title: dto.title,
    description: dto.description,
    contentLength: dto.contentLength,
    content: includeContent ? dto.content : null,
    tags: dto.tags,
    customers: dto.customers,
    delivery: dto.delivery,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

export function corpusRoutes(app: FastifyInstance, opts: CorpusRoutesOptions): void {
  const { db } = opts;

  app.get(
    "/api/v1/corpus/documents",
    { preHandler: requireCorpusAccess },
    async (req) => {
      const query = corpusDocumentsQuerySchema.parse(req.query ?? {});
      // tagNames → tagIds 并入 AND（K63 同语义：解析不到 live material 域词 → 空结果）
      let effective = query;
      if (query.tagNames !== undefined) {
        const byName = findLiveMaterialTagIdsByNames(db, query.tagNames);
        if (query.tagNames.some((n) => !byName.has(n))) {
          return { data: [], meta: { ...listMeta(query.page, query.pageSize, 0), nextSince: null } };
        }
        effective = {
          ...query,
          tagNames: undefined,
          tagIds: [...new Set([...(query.tagIds ?? []), ...query.tagNames.map((n) => byName.get(n)!)])],
        };
      }
      const { rows, total } = listCorpusDocuments(db, effective);
      const includeContent = query.include === "content";
      const detailById = new Map(
        assembleMaterialDetails(db, rows.filter((r) => r.deletedAt === null)).map((d) => [d.id, d] as const),
      );
      const data = rows.map((row) =>
        row.deletedAt !== null
          ? { id: row.id, deleted: true as const, updatedAt: row.updatedAt }
          : toCorpusDocument(detailById.get(row.id)!, includeContent),
      );
      const nextSince = rows.length > 0 ? Math.max(...rows.map((r) => r.updatedAt)) : null;
      return { data, meta: { ...listMeta(query.page, query.pageSize, total), nextSince } };
    },
  );

  app.get(
    "/api/v1/corpus/documents/:id",
    { preHandler: requireCorpusAccess },
    async (req) => {
      const { id } = idParamSchema.parse(req.params);
      const row = getCorpusDocumentRow(db, id);
      if (!row) throw notFound("语料不存在");
      return { data: toCorpusDocument(assembleMaterialDetail(db, row), true) };
    },
  );

  app.get("/api/v1/corpus/head", { preHandler: requireCorpusAccess }, async () => {
    return { data: corpusHeadState(db) };
  });
}
