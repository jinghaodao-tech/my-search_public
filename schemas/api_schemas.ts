import { z } from 'zod';

const authoritySchema = z.number().min(0).max(1);

export const collectorConfigSchema = z.object({
  rss: z.array(z.object({
    url: z.string().trim().url().max(2048),
    label: z.string().trim().min(1).max(120),
    authority: authoritySchema,
  }).strict()).max(100),
  arxiv: z.array(z.object({
    query: z.string().trim().min(1).max(200),
    maxResults: z.number().int().min(1).max(100),
    authority: authoritySchema,
  }).strict()).max(100),
  github: z.array(z.object({
    language: z.string().trim().min(1).max(80),
    since: z.enum(['daily', 'weekly', 'monthly']),
    authority: authoritySchema,
  }).strict()).max(100),
}).strict();

export const collectBodySchema = z.object({
  background: z.boolean().optional(),
  config: collectorConfigSchema.optional(),
}).strict();

export const schedulerStartSchema = z.object({
  cronExpr: z.string().trim().min(1).max(120).optional(),
}).strict();

const bm25KeywordSchema = z.object({
  term: z.string().trim().min(1).max(100),
  weight: z.number().min(0).max(20),
  synonyms: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
}).passthrough();

const runConfigSchema = z.object({
  label: z.string().max(120).default('Custom'),
  description: z.string().max(1000).default(''),
  k1: z.number(),
  b: z.number(),
  lambda: z.number(),
  contextBonus: z.number(),
  keywords: z.array(bm25KeywordSchema).max(200),
}).passthrough();

const runArticleSchema = z.object({
  id: z.string().trim().min(1).max(300),
  title: z.string().max(500),
  body: z.string().max(50000).default(''),
  publishedAt: z.union([z.string(), z.date()]),
  sourceAuthority: z.number().min(0).max(1).optional(),
  url: z.string().max(2048).optional(),
}).passthrough();

const runOptionsSchema = z.object({
  dedupThreshold: z.number().optional(),
  archiveScoreThreshold: z.number().optional(),
  resultLimit: z.number().optional(),
}).passthrough();

export const runBodySchema = z.object({
  modeId: z.string().trim().min(1).max(100).optional(),
  config: runConfigSchema,
  articles: z.array(runArticleSchema).max(10000).optional(),
  options: runOptionsSchema.optional(),
}).strict();

export const candidateStatusSchema = z.enum(["unreviewed", "reviewed_not_saved", "saved_as_card", "expired"]);
const idSchema = z.string().trim().min(1).max(200);

const urlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(value => value === '' || z.string().url().safeParse(value).success, {
    message: 'Invalid url',
  })
  .optional();

const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(30).optional();

const cardFieldsSchema = {
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20000).default(''),
  url: urlSchema,
  tags: tagsSchema.default([]),
  type: z.enum(['article', 'memo', 'csv']).optional(),
  color: z.string().trim().max(50).optional(),
  kjGroupId: z.string().trim().max(200).nullable().optional(),
  summary: z.string().max(20000).optional(),
};

export const cardListQuerySchema = z.object({ tag: z.string().trim().max(50).optional(), kjGroupId: z.string().trim().max(200).optional(), type: z.enum(["article", "memo", "csv"]).optional(), q: z.string().max(500).optional(), archived: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).optional(), sort: z.enum(["created_at_asc", "created_at_desc", "createdAtAsc", "createdAtDesc"]).optional(), }).strict();

export const createCardSchema = z.object(cardFieldsSchema).strict();

/**
 * @internal Schema for card payloads created by internal import/migration paths.
 */
export const systemCreateCardSchema = createCardSchema.extend({
  id: idSchema.optional(),
});

export const updateCardSchema = z.object({
  ...cardFieldsSchema,
  title: cardFieldsSchema.title.optional(),
  body: z.string().max(20000).optional(),
  tags: tagsSchema,
  archived: z.boolean().optional(),
  archivedAt: z.string().datetime().optional(),
  note: z.string().max(20000).optional(),
}).strict();

export const idsBodySchema = z.object({
  ids: z.array(idSchema).min(1).max(500),
}).strict();

export const linkBodySchema = z.object({
  targetId: idSchema,
}).strict();

export const csvImportSchema = z.object({
  csv: z.string().trim().min(1).max(1_000_000),
}).strict();

export const jsonImportSchema = z.object({
  json: z.string().trim().min(1).max(1_000_000),
}).strict();

export const importArticlesSchema = z.object({
  articleIds: z.array(idSchema).max(1000).optional(),
}).strict();

export const keywordExpandSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(30),
}).strict();

export const kjGroupCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  color: z.string().trim().min(1).max(50),
}).strict();

export const kjGroupUpdateSchema = kjGroupCreateSchema.partial().strict();

export const kjAssignSchema = z.object({
  cardId: idSchema,
}).strict();