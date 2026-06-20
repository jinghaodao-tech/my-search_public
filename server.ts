/**
 * server.ts — BM25 Web サーバー + カード管理統合版
 * 起動: npx tsx server.ts
 * GUI:  http://localhost:3000
 */
import fs                from 'fs';
import dotenv            from 'dotenv';
import express           from 'express';
import cors              from 'cors';
import path              from 'path';
import { fileURLToPath } from 'url';
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
        `以下の記事を日本語で3行以内に要約してください。数字・固有名詞は省略しないでください。\n\n` +
        `タイトル: ${card.title}\n本文: ${card.body}`,
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
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ── 収集結果キャッシュ ───────────────────────────────────────────
let cachedArticles: CollectResult | null = loadArticles();
let collectorConfig: CollectorConfig = DEFAULT_CONFIG;
let schedulerStop: (() => void) | null = null;

// ════════════════════════════════════════════════════
//  既存 BM25 / Collect API
// ════════════════════════════════════════════════════

app.get('/api/modes', (_req, res) => res.json(MODES));

app.get('/api/articles', (_req, res) => {
  if (!cachedArticles) {
    res.json({ articles: [], stats: null, message: '未収集。/api/collect を呼んでください' });
    return;
  }
  res.json(cachedArticles);
});

app.post('/api/collect', async (req, res) => {
  try {
    const config: CollectorConfig = req.body?.config ?? collectorConfig;
    collectorConfig = config;
    const result = await collectAll(config);
    cachedArticles = result;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/collect/config',  (_req, res) => res.json(collectorConfig));
app.post('/api/collect/config', (req, res) => {
  collectorConfig = req.body as CollectorConfig;
  res.json({ ok: true });
});

app.post('/api/scheduler/start', (req, res) => {
  if (schedulerStop) { res.json({ ok: false, message: '既に起動中' }); return; }
  const expr = (req.body?.cronExpr as string) ?? '*/30 * * * *';
  schedulerStop = startScheduler({
    cronExpr: expr, config: collectorConfig,
    onCollect: (r) => { cachedArticles = r; saveArticles(r); },
  });
  res.json({ ok: true, cronExpr: expr });
});

app.post('/api/scheduler/stop', (_req, res) => {
  if (schedulerStop) { schedulerStop(); schedulerStop = null; }
  res.json({ ok: true });
});

app.get('/api/scheduler/status', (_req, res) => res.json({ running: !!schedulerStop }));

app.post('/api/run', async (req, res) => {
  try {
    const { modeId, config, articles: reqArticles, options } = req.body;
    if (!config) { res.status(400).json({ error: 'config は必須です' }); return; }
    const rawArticles = reqArticles ?? cachedArticles?.articles ?? [];
    if (!rawArticles.length) {
      res.status(400).json({ error: '記事がありません。先に /api/collect を実行してください' });
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

// ════════════════════════════════════════════════════
//  § A. カードCRUD API
// ════════════════════════════════════════════════════

/** 全カード取得（タグ・KJグループでフィルタ可） */
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

/** カード作成（メモ新規） */
app.post('/api/cards', async (req, res) => {
  try {
    const card = await createCard({ type: 'memo', ...req.body });
    res.status(201).json(card);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

/** カード取得 */
app.get('/api/cards/:id', (req, res) => {
  const card = getCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  const backlinks = getBacklinks(req.params.id);
  res.json({ ...card, backlinks });
});

/** カード更新 */
app.put('/api/cards/:id', async (req, res) => {
  const card = await updateCard(req.params.id, req.body);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(card);
});

/** カード削除 */
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
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids is required' });
    return;
  }
  const now = new Date().toISOString();
  const updated: string[] = [];
  for (const id of ids) {
    const card = await updateCard(id, { archived: true, archivedAt: now });
    if (card) updated.push(id);
  }
  res.json({ ok: true, updated });
});

app.post('/api/cards/bulk-archive', (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids is required' });
    return;
  }
  const updated = bulkArchiveCards(ids);
  res.json({ ok: true, updated });
});

app.post('/api/cards/bulk-restore', (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids is required' });
    return;
  }
  const updated = bulkRestoreCards(ids);
  res.json({ ok: true, updated });
});

app.post('/api/cards/bulk-delete', (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids is required' });
    return;
  }
  const deleted = bulkDeleteCards(ids);
  res.json({ ok: true, deleted });
});

// ════════════════════════════════════════════════════
//  § B. AI要約 API
// ════════════════════════════════════════════════════

app.post('/api/cards/:id/summarize', async (req, res) => {
  const card = getCard(req.params.id);
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

/** 複数カードを一括要約（バックグラウンド） */
app.post('/api/cards/summarize-bulk', async (req, res) => {
  const { ids }: { ids: string[] } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    res.status(400).json({ error: 'ids is required', code: 'invalid_request' });
    return;
  }
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
  res.json({ ok: true, message: `${ids.length}件の要約を開始しました` });

  // バックグラウンド処理
  (async () => {
    for (const id of ids) {
      const card = getCard(id);
      if (!card || card.summary) continue;
      try {
        const summary = await summarizeCard(card);
        await updateCard(id, { summary });
        await new Promise(r => setTimeout(r, 300)); // レート制限対応
      } catch (error) {
        console.error('[AI SUMMARY] bulk summarize failed:', { id, error });
      }
    }
  })();
});

// ════════════════════════════════════════════════════
//  § C. Zettelkasten リンク API
// ════════════════════════════════════════════════════

app.post('/api/cards/:id/links', (req, res) => {
  const { targetId } = req.body as { targetId: string };
  linkCards(req.params.id, targetId);
  res.json({ ok: true });
});

app.delete('/api/cards/:id/links/:targetId', (req, res) => {
  unlinkCards(req.params.id, req.params.targetId);
  res.json({ ok: true });
});

app.get('/api/cards/:id/backlinks', (req, res) => {
  res.json(getBacklinks(req.params.id));
});

/** Zettelkastenグラフデータ（vis.js用） */
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

// ════════════════════════════════════════════════════
//  § D. KJ法グループ API
// ════════════════════════════════════════════════════

app.get('/api/kj/groups', (_req, res) => {
  const groups = loadKJGroups();
  const cards  = loadCards();
  const result = groups.map(g => ({
    ...g,
    cards: cards.filter(c => c.kjGroupId === g.id),
  }));
  // 未グループカード
  const ungrouped = cards.filter(c => !c.kjGroupId);
  res.json({ groups: result, ungrouped });
});

app.post('/api/kj/groups', (req, res) => {
  const { name, description, color } = req.body as KJGroup;
  const group = createKJGroup(name, description, color);
  res.status(201).json(group);
});

app.put('/api/kj/groups/:id', (req, res) => {
  const group = updateKJGroup(req.params.id, req.body);
  if (!group) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(group);
});

app.delete('/api/kj/groups/:id', (req, res) => {
  deleteKJGroup(req.params.id);
  res.json({ ok: true });
});

/** カードをグループへ割り当て */
app.post('/api/kj/groups/:id/cards', async (req, res) => {
  const { cardId } = req.body as { cardId: string };
  await assignKJGroup(cardId, req.params.id);
  res.json({ ok: true });
});

/** カードをグループから外す */
app.delete('/api/kj/groups/:id/cards/:cardId', async (req, res) => {
  await assignKJGroup(req.params.cardId, null);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════
//  § E. タグ API
// ════════════════════════════════════════════════════

app.get('/api/tags', (_req, res) => res.json(getAllTags()));

// ════════════════════════════════════════════════════
//  § F. CSV インポート API
// ════════════════════════════════════════════════════

app.post('/api/cards/import-csv', (req, res) => {
  try {
    const { csv } = req.body as { csv: string };
    if (!csv) { res.status(400).json({ error: 'csv フィールドが必要です' }); return; }
    const imported = parseAndImportCSV(csv);
    res.json({ ok: true, count: imported.length, cards: imported });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** JSON取り込み */
app.post('/api/cards/import-json', (req, res) => {
  try {
    const { json } = req.body as { json: string };
    if (!json) { res.status(400).json({ error: 'json フィールドが必要です' }); return; }
    const result = parseAndImportJSON(json);
    res.json({ ok: true, count: result.cards.length, warnings: result.warnings, cards: result.cards });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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

// ════════════════════════════════════════════════════
//  起動
// ════════════════════════════════════════════════════
await backfillCardTokens();
if (cachedArticles) {
  cachedArticles = await ensureArticleTokens(cachedArticles);
  saveArticles(cachedArticles);
}

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`\n  ✓ カード管理サーバー  http://localhost:${PORT}`);
  console.log(`  ✓ GUI                http://localhost:${PORT}/\n`);
});
