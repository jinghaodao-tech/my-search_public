/**
 * server.ts 窶・BM25 Web 繧ｵ繝ｼ繝舌・ + 繧ｫ繝ｼ繝臥ｮ｡逅・ｵｱ蜷育沿
 * 襍ｷ蜍・ npx tsx server.ts
 * GUI:  http://localhost:3000
 */
import fs                from 'fs';
import dotenv            from 'dotenv';
import express           from 'express';
import cors              from 'cors';
import helmet            from 'helmet';
import rateLimit         from 'express-rate-limit';
import path              from 'path';
import { fileURLToPath } from 'url';
import { z, type ZodError, type ZodType } from 'zod';
import { runPipeline, MODES } from './bm25_engine.js';
import {
  collectAll, startScheduler, saveArticles, loadArticles, ensureArticleTokens,
  DEFAULT_CONFIG,
  type CollectorConfig,
  type CollectResult,
} from './collector.js';
import {
  loadCards, getCards, createCard, updateCard, deleteCard, getCard,
  bulkArchiveCards, bulkRestoreCards, bulkDeleteCards, restoreCard,
  linkCards, unlinkCards, getBacklinks, getAllTags,
  loadKJGroups, createKJGroup, updateKJGroup, deleteKJGroup, assignKJGroup,
  parseAndImportCSV,
  parseAndImportJSON, backfillCardTokens
} from './cards_engine.js';

import type {
  Card,
  KJGroup
} from './cards_engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

for (const envPath of [
  path.join(__dirname, '.env'),
  path.join(path.dirname(__dirname), 'my-search-app', '.env'),
]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL =
  process.env.ANTHROPIC_MODEL ??
  'claude-haiku-4-5-20251001';
const AI_PROVIDER = (process.env.AI_PROVIDER ?? 'anthropic').trim().toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
const MOCK_AI_SUMMARY = process.env.MOCK_AI_SUMMARY?.trim().toLowerCase() === 'true';
const AI_DEBUG = process.env.NODE_ENV !== 'production';

type AiSummaryErrorCode =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'timeout'
  | 'empty_summary'
  | 'api_error';

class AiSummaryError extends Error {
  status: number;
  code: AiSummaryErrorCode;
  details?: string;

  constructor(status: number, code: AiSummaryErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'AiSummaryError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getAnthropicApiKey(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function getGeminiApiKey(): string | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function logMissingApiKey() {
  console.error('[AI SUMMARY]');
  console.error('ANTHROPIC_API_KEY is not configured');
}

function buildMissingApiKeyResponse() {
  return {
    error: '\u0041\u004e\u0054\u0048\u0052\u004f\u0050\u0049\u0043_\u0041\u0050\u0049_\u004b\u0045\u0059 \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093',
    code: 'missing_api_key',
  };
}

function mapAnthropicStatus(status: number, body: string): AiSummaryError {
  switch (status) {
    case 401:
      return new AiSummaryError(status, 'invalid_api_key', '\u0041\u0050\u0049\u30ad\u30fc\u304c\u7121\u52b9\u3067\u3059', body);
    case 403:
      return new AiSummaryError(status, 'forbidden', '\u0041\u0050\u0049\u8a8d\u8a3c\u30a8\u30e9\u30fc', body);
    case 404:
      return new AiSummaryError(status, 'model_not_found', '\u30e2\u30c7\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093', body);
    case 429:
      return new AiSummaryError(status, 'rate_limited', '\u30ec\u30fc\u30c8\u5236\u9650\u306b\u9054\u3057\u307e\u3057\u305f', body);
    case 500:
      return new AiSummaryError(status, 'server_error', '\u30b5\u30fc\u30d0\u30fc\u30a8\u30e9\u30fc', body);
    default:
      if (status >= 500) {
        return new AiSummaryError(status, 'server_error', '\u30b5\u30fc\u30d0\u30fc\u30a8\u30e9\u30fc', body);
      }
      return new AiSummaryError(status, 'api_error', '\u0041\u006e\u0074\u0068\u0072\u006f\u0070\u0069\u0063 API\u3067\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f', body);
  }
}

function buildSummaryPayload(card: Card) {
  return {
    model: MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user' as const,
      content:
        `莉･荳九・險倅ｺ九ｒ譌･譛ｬ隱槭〒3陦御ｻ･蜀・↓隕∫ｴ・＠縺ｦ縺上□縺輔＞縲よ焚蟄励・蝗ｺ譛牙錐隧槭・逵∫払縺励↑縺・〒縺上□縺輔＞縲・n\n` +
        `繧ｿ繧､繝医Ν: ${card.title}\n譛ｬ譁・ ${card.body}`,
    }],
  };
}

async function summarizeWithAnthropic(card: Card): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    logMissingApiKey();
    throw new AiSummaryError(500, 'missing_api_key', '\u0041\u004e\u0054\u0048\u0052\u004f\u0050\u0049\u0043_\u0041\u0050\u0049_\u004b\u0045\u0059 \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093');
  }

  const payload = buildSummaryPayload(card);
  if (AI_DEBUG) {
    console.log('[AI SUMMARY] request payload:', payload);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseBody = await response.text();
    if (AI_DEBUG) {
      console.log('[AI SUMMARY] response body:', responseBody);
    }

    if (!response.ok) {
      console.error('[AI SUMMARY]', {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
      throw mapAnthropicStatus(response.status, responseBody);
    }

    let data: { content?: Array<{ text?: string }> };
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new AiSummaryError(500, 'api_error', '\u0041\u006e\u0074\u0068\u0072\u006f\u0070\u0069\u0063 API\u306e\u30ec\u30b9\u30dd\u30f3\u30b9\u3092\u89e3\u6790\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f', responseBody);
    }

    const summary = data.content?.[0]?.text?.trim() ?? '';
    if (!summary) {
      throw new AiSummaryError(500, 'empty_summary', '\u8981\u7d04\u7d50\u679c\u304c\u7a7a\u3067\u3057\u305f', responseBody);
    }

    return summary;
  } catch (error) {
    if (error instanceof AiSummaryError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiSummaryError(500, 'timeout', '\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u30a8\u30e9\u30fc');
    }
    throw new AiSummaryError(500, 'network_error', '\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u30a8\u30e9\u30fc', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function summarizeWithGemini(card: Card): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    console.error('[AI SUMMARY]');
    console.error('GEMINI_API_KEY is not configured');
    throw new AiSummaryError(500, 'missing_api_key', 'GEMINI_API_KEY is not configured');
  }

  const payload = {
    contents: [{
      parts: [{
        text: buildSummaryPayload(card).messages[0].content,
      }],
    }],
  };
  if (AI_DEBUG) {
    console.log('[AI SUMMARY] Gemini request payload:', payload);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseBody = await response.text();

    if (AI_DEBUG) {
      console.log('[AI SUMMARY] Gemini response body:', responseBody);
    }
    if (!response.ok) {
      console.error('[AI SUMMARY] Gemini Error:', {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
      throw mapAnthropicStatus(response.status, responseBody);
    }

    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new AiSummaryError(500, 'api_error', 'Invalid Gemini API response', responseBody);
    }

    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!summary) {
      throw new AiSummaryError(500, 'empty_summary', 'Gemini returned an empty summary', responseBody);
    }
    return summary;
  } catch (error) {
    if (error instanceof AiSummaryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiSummaryError(500, 'timeout', 'Gemini API request timed out');
    }
    throw new AiSummaryError(500, 'network_error', 'Gemini API network error', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}


function extractJsonArray(text: string): string[] {
  const trimmed = text.trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/i, '').trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  const raw = match ? match[0] : trimmed;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0 && item.length <= 50)
    .slice(0, 10);
}

function buildKeywordExpansionPrompt(keywords: string[]): string {
  return [
    'Generate search synonyms and related terms for BM25 search.',
    'Return only a JSON array of strings. Do not return explanations.',
    'Keep proper nouns as-is. Mix Japanese and English terms when useful.',
    'Maximum 10 terms. Avoid duplicates and avoid the original input terms.',
    `Input keywords: ${JSON.stringify(keywords)}`,
  ].join('\n');
}

async function expandKeywordsWithAnthropic(keywords: string[]): Promise<string[]> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new AiSummaryError(500, 'missing_api_key', 'ANTHROPIC_API_KEY is not configured');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: buildKeywordExpansionPrompt(keywords) }],
      }),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) throw mapAnthropicStatus(response.status, responseBody);
    const data = JSON.parse(responseBody) as { content?: Array<{ text?: string }> };
    return extractJsonArray(data.content?.[0]?.text ?? '[]');
  } catch (error) {
    if (error instanceof AiSummaryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiSummaryError(500, 'timeout', 'AI keyword expansion timed out');
    throw new AiSummaryError(500, 'api_error', 'AI keyword expansion failed', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function expandKeywordsWithGemini(keywords: string[]): Promise<string[]> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new AiSummaryError(500, 'missing_api_key', 'GEMINI_API_KEY is not configured');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildKeywordExpansionPrompt(keywords) }] }] }),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) throw mapAnthropicStatus(response.status, responseBody);
    const data = JSON.parse(responseBody) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return extractJsonArray(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]');
  } catch (error) {
    if (error instanceof AiSummaryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiSummaryError(500, 'timeout', 'AI keyword expansion timed out');
    throw new AiSummaryError(500, 'api_error', 'AI keyword expansion failed', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function expandSearchKeywords(keywords: string[]): Promise<string[]> {
  if (MOCK_AI_SUMMARY) {
    return ['implementation', 'development', 'code', 'repository', 'package', 'library', 'debug', 'architecture', 'API', 'module'];
  }
  if (AI_PROVIDER === 'gemini') return expandKeywordsWithGemini(keywords);
  if (AI_PROVIDER === 'anthropic') return expandKeywordsWithAnthropic(keywords);
  throw new AiSummaryError(500, 'api_error', `Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
}

async function summarizeCard(card: Card): Promise<string> {
  if (MOCK_AI_SUMMARY) {
    return card.body.trim().slice(0, 120) || card.title.trim();
  }
  if (AI_PROVIDER === 'gemini') return summarizeWithGemini(card);
  if (AI_PROVIDER === 'anthropic') return summarizeWithAnthropic(card);
  throw new AiSummaryError(500, 'api_error', `Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
}

function hasConfiguredProviderKey(): boolean {
  if (MOCK_AI_SUMMARY) return true;
  if (AI_PROVIDER === 'gemini') return !!getGeminiApiKey();
  if (AI_PROVIDER === 'anthropic') return !!getAnthropicApiKey();
  return false;
}

if (!MOCK_AI_SUMMARY && AI_PROVIDER === 'gemini' && !getGeminiApiKey()) {
  console.error('[AI SUMMARY]');
  console.error('GEMINI_API_KEY is not configured');
} else if (!MOCK_AI_SUMMARY && AI_PROVIDER === 'anthropic' && !getAnthropicApiKey()) {
  logMissingApiKey();
}

const app = express();
export { app };

const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3000';
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT ?? 60),
  standardHeaders: true,
  legacyHeaders: false,
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.AI_RATE_LIMIT ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
});
const importLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.IMPORT_RATE_LIMIT ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// 笏笏 蜿朱寔邨先棡繧ｭ繝｣繝・す繝･ 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
let cachedArticles: CollectResult | null = loadArticles();
let collectorConfig: CollectorConfig = DEFAULT_CONFIG;
let schedulerStop: (() => void) | null = null;
let schedulerCronExpr: string | null = null;
let collectRunning = false;

function isCollectorConfig(value: unknown): value is CollectorConfig {
  return collectorConfigSchema.safeParse(value).success;
}

function resolveCollectorConfig(value: unknown): CollectorConfig {
  if (isCollectorConfig(value)) return value;
  if (isCollectorConfig(collectorConfig)) return collectorConfig;
  return DEFAULT_CONFIG;
}

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  譌｢蟄・BM25 / Collect API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武


const authoritySchema = z.number().min(0).max(1);
const collectorConfigSchema = z.object({
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
const collectBodySchema = z.object({
  background: z.boolean().optional(),
  config: collectorConfigSchema.optional(),
}).strict();
const schedulerStartSchema = z.object({
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
  noViewDays: z.number().optional(),
}).passthrough();
const runBodySchema = z.object({
  modeId: z.string().trim().min(1).max(100).optional(),
  config: runConfigSchema,
  articles: z.array(runArticleSchema).max(10000).optional(),
  options: runOptionsSchema.optional(),
}).strict();

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
const createCardSchema = z.object(cardFieldsSchema).strict();
const updateCardSchema = z.object({
  ...cardFieldsSchema,
  title: cardFieldsSchema.title.optional(),
  body: z.string().max(20000).optional(),
  tags: tagsSchema,
  archived: z.boolean().optional(),
  archivedAt: z.string().datetime().optional(),
  note: z.string().max(20000).optional(),
}).strict();
const idsBodySchema = z.object({
  ids: z.array(idSchema).min(1).max(500),
}).strict();
const linkBodySchema = z.object({
  targetId: idSchema,
}).strict();
const csvImportSchema = z.object({
  csv: z.string().trim().min(1).max(1_000_000),
}).strict();
const jsonImportSchema = z.object({
  json: z.string().trim().min(1).max(1_000_000),
}).strict();

const keywordExpandSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(50)).min(1).max(30),
}).strict();

const kjGroupCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  color: z.string().trim().min(1).max(50),
}).strict();
const kjGroupUpdateSchema = kjGroupCreateSchema.partial().strict();
const kjAssignSchema = z.object({
  cardId: idSchema,
}).strict();

function validationDetails(error: ZodError) {
  return error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function invalidRequest(res: express.Response, details: unknown) {
  res.status(400).json({ error: 'Invalid request', details });
}

function parseBody<T>(schema: ZodType<T>, req: express.Request, res: express.Response): T | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, validationDetails(parsed.error));
    return null;
  }
  return parsed.data;
}

function normalizeCardInput<T extends { url?: string | null; kjGroupId?: string | null; note?: unknown }>(body: T) {
  const { note: _note, ...rest } = body;
  return {
    ...rest,
    url: body.url || undefined,
    kjGroupId: body.kjGroupId ?? undefined,
  };
}

app.get('/api/modes', (_req, res) => res.json(MODES));

app.get('/api/articles', (_req, res) => {
  if (!cachedArticles) {
    res.json({ articles: [], stats: null, message: '譛ｪ蜿朱寔縲・api/collect 繧貞他繧薙〒縺上□縺輔＞' });
    return;
  }
  res.json(cachedArticles);
});

app.post(['/api/collect', '/api/articles/refresh'], apiLimiter, async (req, res) => {
  const body = parseBody(collectBodySchema, req, res);
  if (!body) return;
  try {
    const config = resolveCollectorConfig(body.config);
    collectorConfig = config;
    if (body.background) {
      if (collectRunning) {
        res.json({ ok: false, running: true, message: 'collect already running' });
        return;
      }
      collectRunning = true;
      res.status(202).json({ ok: true, running: true, message: 'collect started' });
      collectAll(config)
        .then((result) => { cachedArticles = result; })
        .catch((err) => console.error('[COLLECT]', err))
        .finally(() => { collectRunning = false; });
      return;
    }
    const result = await collectAll(config);
    cachedArticles = result;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/collect/config',  (_req, res) => res.json(collectorConfig));
app.post('/api/collect/config', (req, res) => {
  const body = parseBody(collectorConfigSchema, req, res);
  if (!body) return;
  collectorConfig = body;
  res.json({ ok: true });
});

app.post('/api/scheduler/start', (req, res) => {
  const body = parseBody(schedulerStartSchema, req, res);
  if (!body) return;
  if (schedulerStop) { res.json({ ok: false, message: '譌｢縺ｫ襍ｷ蜍穂ｸｭ' }); return; }
  const expr = body.cronExpr ?? '*/30 * * * *';
  schedulerCronExpr = expr;
  schedulerStop = startScheduler({
    cronExpr: expr, config: collectorConfig,
    onCollect: (r) => { cachedArticles = r; saveArticles(r); },
  });
  res.json({ ok: true, cronExpr: expr });
});

app.post('/api/scheduler/stop', (_req, res) => {
  if (schedulerStop) { schedulerStop(); schedulerStop = null; }
  schedulerCronExpr = null;
  res.json({ ok: true });
});

app.get('/api/scheduler/status', (_req, res) => res.json({
  running: !!schedulerStop,
  collecting: collectRunning,
  cronExpr: schedulerCronExpr,
  lastFetchedAt: cachedArticles?.stats?.fetchedAt ?? null,
  articleCount: cachedArticles?.articles?.length ?? 0,
}));

app.post('/api/run', async (req, res) => {
  const body = parseBody(runBodySchema, req, res);
  if (!body) return;
  try {
    const { modeId, config, articles: reqArticles, options } = body;
    const rawArticles = reqArticles ?? cachedArticles?.articles ?? [];
    if (!rawArticles.length) {
      res.status(400).json({ error: '險倅ｺ九′縺ゅｊ縺ｾ縺帙ｓ縲ょ・縺ｫ /api/collect 繧貞ｮ溯｡後＠縺ｦ縺上□縺輔＞' });
      return;
    }
    const cardsById = new Map(loadCards().map((card) => [card.id, card]));
    const parsed = rawArticles.map((a: any) => {
      const stored = cardsById.get(a.id);
      return {
        ...a,
        title: stored?.title ?? a.title,
        body: stored?.body ?? a.body,
        summary: stored?.summary ?? a.summary,
        tags: stored?.tags ?? a.tags ?? [],
        url: stored?.url ?? a.url ?? '',
        type: stored?.type ?? a.type,
        createdAt: stored?.createdAt ?? a.createdAt,
        updatedAt: stored?.updatedAt ?? a.updatedAt,
        archived: stored?.archived ?? a.archived,
        archivedAt: stored?.archivedAt ?? a.archivedAt,
        publishedAt: new Date(a.publishedAt),
        tokens: stored?.tokens ?? a.tokens,
        docLength: stored?.docLength ?? a.docLength,
      };
    });
    const result = await runPipeline(parsed, config, modeId ?? 'custom', options);
    const stripSearchFields = (article: any) => {
      const { tokens: _tokens, docLength: _docLength, ...publicArticle } = article;
      return {
        ...publicArticle,
        summary: publicArticle.summary ?? null,
        tags: publicArticle.tags ?? [],
        type: publicArticle.type ?? 'article',
        createdAt: publicArticle.createdAt ?? publicArticle.publishedAt,
        archived: publicArticle.archived ?? false,
      };
    };
    const response = {
      ...result,
      active: result.active.map((item) => ({
        ...item,
        article: stripSearchFields(item.article),
      })),
      archived: result.archived.map((item) => ({
        ...item,
        article: stripSearchFields(item.article),
      })),
    };
    console.log("results.length", response.active.length + response.archived.length);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  ﾂｧ A. 繧ｫ繝ｼ繝韻RUD API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武

/** 蜈ｨ繧ｫ繝ｼ繝牙叙蠕暦ｼ医ち繧ｰ繝ｻKJ繧ｰ繝ｫ繝ｼ繝励〒繝輔ぅ繝ｫ繧ｿ蜿ｯ・・*/

app.post('/api/search/expand-keywords', aiLimiter, async (req, res) => {
  const body = parseBody(keywordExpandSchema, req, res);
  if (!body) return;
  try {
    const original = new Set(body.keywords.map((keyword) => keyword.toLowerCase()));
    const seen = new Set(original);
    const expandedKeywords = (await expandSearchKeywords(body.keywords))
      .map((keyword) => keyword.trim())
      .filter((keyword) => {
        const key = keyword.toLowerCase();
        if (!keyword || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
    res.json({ expandedKeywords });
  } catch (err) {
    if (err instanceof AiSummaryError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: String(err), code: 'api_error' });
  }
});

app.get('/api/cards', (req, res) => {
  const { tag, kjGroupId, type, q, archived } = req.query as Record<string, string>;
  res.json(getCards({
    tag,
    kjGroupId,
    type,
    q,
    archived: archived === 'true' ? true : archived === 'false' ? false : undefined,
  }));
});

/** 繧ｫ繝ｼ繝我ｽ懈・・医Γ繝｢譁ｰ隕擾ｼ・*/
app.post('/api/cards', async (req, res) => {
  const body = parseBody(createCardSchema, req, res);
  if (!body) return;
  try {
    const card = await createCard({ type: 'memo', ...normalizeCardInput(body) });
    res.status(201).json(card);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

/** 繧ｫ繝ｼ繝牙叙蠕・*/
app.get('/api/cards/:id', (req, res) => {
  const card = getCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  const backlinks = getBacklinks(req.params.id);
  res.json({ ...card, backlinks });
});

/** 繧ｫ繝ｼ繝画峩譁ｰ */
app.put('/api/cards/:id', async (req, res) => {
  const body = parseBody(updateCardSchema, req, res);
  if (!body) return;
  const card = await updateCard(req.params.id, normalizeCardInput(body));
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(card);
});

/** 繧ｫ繝ｼ繝牙炎髯､ */
app.delete('/api/cards/:id', (req, res) => {
  const ok = deleteCard(req.params.id);
  res.json({ ok });
});

app.put('/api/cards/:id/archive', async (req, res) => {
  const card = await updateCard(req.params.id, { archived: true, archivedAt: new Date().toISOString() });
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(card);
});

app.put('/api/cards/:id/unarchive', async (req, res) => {
  const card = await restoreCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(card);
});

app.post('/api/cards/:id/restore', async (req, res) => {
  const card = await restoreCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(card);
});

app.post('/api/cards/archive-bulk', async (req, res) => {
  const body = parseBody(idsBodySchema, req, res);
  if (!body) return;
  const now = new Date().toISOString();
  const updated: string[] = [];
  for (const id of body.ids) {
    const card = await updateCard(id, { archived: true, archivedAt: now });
    if (card) updated.push(id);
  }
  res.json({ ok: true, updated });
});

app.post('/api/cards/bulk-archive', (req, res) => {
  const body = parseBody(idsBodySchema, req, res);
  if (!body) return;
  const updated = bulkArchiveCards(body.ids);
  res.json({ ok: true, updated });
});

app.post('/api/cards/bulk-restore', (req, res) => {
  const body = parseBody(idsBodySchema, req, res);
  if (!body) return;
  const updated = bulkRestoreCards(body.ids);
  res.json({ ok: true, updated });
});

app.post('/api/cards/bulk-delete', (req, res) => {
  const body = parseBody(idsBodySchema, req, res);
  if (!body) return;
  const deleted = bulkDeleteCards(body.ids);
  res.json({ ok: true, deleted });
});

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  ﾂｧ B. AI隕∫ｴ・API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武


app.delete('/api/cards/:id/summary', async (req, res) => {
  const card = getCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await updateCard(req.params.id, { summary: undefined });
  res.json({ ok: true, card: updated });
});

app.post('/api/cards/:id/summarize', aiLimiter, async (req, res) => {
  const cardId = String(req.params.id);
  const card = getCard(cardId);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }

  try {
    const summary = await summarizeCard(card);
    const updated = await updateCard(card.id, { summary });
    res.json({ summary, card: updated });
  } catch (err) {
    if (err instanceof AiSummaryError) {
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: AI_DEBUG ? err.details : undefined,
      });
      return;
    }
    res.status(500).json({ error: '\u0041\u006e\u0074\u0068\u0072\u006f\u0070\u0069\u0063 API\u3067\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f', code: 'api_error' });
  }
});

/** 隍・焚繧ｫ繝ｼ繝峨ｒ荳諡ｬ隕∫ｴ・ｼ医ヰ繝・け繧ｰ繝ｩ繧ｦ繝ｳ繝会ｼ・*/
app.post('/api/cards/summarize-bulk', aiLimiter, async (req, res) => {
  const body = parseBody(idsBodySchema, req, res);
  if (!body) return;
  if (!hasConfiguredProviderKey()) {
    const keyName = AI_PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    console.error('[AI SUMMARY]');
    console.error(`${keyName} is not configured`);
    res.status(500).json({
      error: `${keyName} is not configured`,
      code: 'missing_api_key',
    });
    return;
  }
  res.json({ ok: true, message: `${body.ids.length}莉ｶ縺ｮ隕∫ｴ・ｒ髢句ｧ九＠縺ｾ縺励◆` });

  // 繝舌ャ繧ｯ繧ｰ繝ｩ繧ｦ繝ｳ繝牙・逅・
  (async () => {
    for (const id of body.ids) {
      const card = getCard(id);
      if (!card || card.summary) continue;
      try {
        const summary = await summarizeCard(card);
        await updateCard(id, { summary });
        await new Promise(r => setTimeout(r, 300)); // 繝ｬ繝ｼ繝亥宛髯仙ｯｾ蠢・
      } catch (error) {
        console.error('[AI SUMMARY] bulk summarize failed:', { id, error });
      }
    }
  })();
});

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  ﾂｧ C. Zettelkasten 繝ｪ繝ｳ繧ｯ API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武

app.post('/api/cards/:id/links', (req, res) => {
  const body = parseBody(linkBodySchema, req, res);
  if (!body) return;
  if (req.params.id === body.targetId) {
    invalidRequest(res, [{ path: 'targetId', message: 'Cannot link a card to itself' }]);
    return;
  }
  if (!getCard(req.params.id) || !getCard(body.targetId)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  linkCards(req.params.id, body.targetId);
  res.json({ ok: true });
});

app.delete('/api/cards/:id/links/:targetId', (req, res) => {
  unlinkCards(req.params.id, req.params.targetId);
  res.json({ ok: true });
});

app.get('/api/cards/:id/backlinks', (req, res) => {
  res.json(getBacklinks(req.params.id));
});

/** Zettelkasten繧ｰ繝ｩ繝輔ョ繝ｼ繧ｿ・・is.js逕ｨ・・*/
app.get('/api/zettelkasten/graph', (_req, res) => {
  const cards = loadCards();
  const nodes = cards.map(c => ({
    id:    c.id,
    label: c.title.slice(0, 40),
    title: c.summary ?? c.body.slice(0, 100),
    group: c.type,
    color: c.color,
  }));
  const edgesSet = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  for (const card of cards) {
    for (const linkId of card.links) {
      const key = [card.id, linkId].sort().join('--');
      if (!edgesSet.has(key)) {
        edgesSet.add(key);
        edges.push({ from: card.id, to: linkId });
      }
    }
  }
  res.json({ nodes, edges });
});

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  ﾂｧ D. KJ豕輔げ繝ｫ繝ｼ繝・API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武

app.get('/api/kj/groups', (_req, res) => {
  const groups = loadKJGroups();
  const cards  = loadCards();
  const result = groups.map(g => ({
    ...g,
    cards: cards.filter(c => c.kjGroupId === g.id),
  }));
  // 譛ｪ繧ｰ繝ｫ繝ｼ繝励き繝ｼ繝・
  const ungrouped = cards.filter(c => !c.kjGroupId);
  res.json({ groups: result, ungrouped });
});

app.post('/api/kj/groups', (req, res) => {
  const body = parseBody(kjGroupCreateSchema, req, res);
  if (!body) return;
  const { name, description, color } = body;
  const group = createKJGroup(name, description, color);
  res.status(201).json(group);
});

app.put('/api/kj/groups/:id', (req, res) => {
  const body = parseBody(kjGroupUpdateSchema, req, res);
  if (!body) return;
  const group = updateKJGroup(req.params.id, body);
  if (!group) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(group);
});

app.delete('/api/kj/groups/:id', (req, res) => {
  deleteKJGroup(req.params.id);
  res.json({ ok: true });
});

/** 繧ｫ繝ｼ繝峨ｒ繧ｰ繝ｫ繝ｼ繝励∈蜑ｲ繧雁ｽ薙※ */
app.post('/api/kj/groups/:id/cards', async (req, res) => {
  const body = parseBody(kjAssignSchema, req, res);
  if (!body) return;
  await assignKJGroup(body.cardId, req.params.id);
  res.json({ ok: true });
});

/** 繧ｫ繝ｼ繝峨ｒ繧ｰ繝ｫ繝ｼ繝励°繧牙､悶☆ */
app.delete('/api/kj/groups/:id/cards/:cardId', async (req, res) => {
  await assignKJGroup(req.params.cardId, null);
  res.json({ ok: true });
});

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  ﾂｧ E. 繧ｿ繧ｰ API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武

app.get('/api/tags', (_req, res) => res.json(getAllTags()));

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  ﾂｧ F. CSV 繧､繝ｳ繝昴・繝・API
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武

app.post('/api/cards/import-csv', importLimiter, (req, res) => {
  const body = parseBody(csvImportSchema, req, res);
  if (!body) return;
  try {
    const imported = parseAndImportCSV(body.csv);
    if (!imported.length) {
      invalidRequest(res, [{ path: 'csv', message: 'CSV must include a header and at least one valid row' }]);
      return;
    }
    res.json({ ok: true, count: imported.length, cards: imported });
  } catch (err) {
    invalidRequest(res, String(err));
  }
});

/** JSON蜿悶ｊ霎ｼ縺ｿ */
app.post('/api/cards/import-json', importLimiter, (req, res) => {
  const body = parseBody(jsonImportSchema, req, res);
  if (!body) return;
  try {
    const result = parseAndImportJSON(body.json);
    if (!result.cards.length) {
      invalidRequest(res, [{ path: 'json', message: 'JSON must contain at least one importable card' }]);
      return;
    }
    res.json({ ok: true, count: result.cards.length, warnings: result.warnings, cards: result.cards });
  } catch (err) {
    invalidRequest(res, String(err));
  }
});


app.post('/api/cards/import-articles', async (req, res) => {
  const { articleIds }: { articleIds?: string[] } = req.body;
  const articles = cachedArticles?.articles ?? [];
  const targets  = articleIds
    ? articles.filter(a => articleIds.includes(a.id))
    : articles;

  const existing = new Set(loadCards().map(c => c.id));
  const imported: Card[] = [];

  for (const a of targets) {
    if (existing.has(`card_from_${a.id}`)) continue;
    const card = await createCard({
      id:    `card_from_${a.id}`,
      title: a.title,
      body:  a.body,
      url:   a.url,
      tags:  [],
      type:  'article',
    } as any);
    imported.push(card);
  }
  res.json({ ok: true, count: imported.length });
});

// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
//  襍ｷ蜍・
// 笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武笊絶武
if (process.env.NODE_ENV !== 'test') {
  await backfillCardTokens();
  if (cachedArticles) {
    cachedArticles = await ensureArticleTokens(cachedArticles);
    saveArticles(cachedArticles);
  }
}

const PORT = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n  笨・繧ｫ繝ｼ繝臥ｮ｡逅・し繝ｼ繝舌・  http://localhost:${PORT}`);
    console.log(`  笨・GUI                http://localhost:${PORT}/\n`);
  });
}

