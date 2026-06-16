/**
 * server.ts — BM25 Web サーバー + カード管理統合版
 * 起動: npx tsx server.ts
 * GUI:  http://localhost:3000
 */
import 'dotenv/config';
import express           from 'express';
import cors              from 'cors';
import path              from 'path';
import { fileURLToPath } from 'url';
import { runPipeline, MODES } from './bm25_engine.js';
import {
  collectAll, startScheduler, saveArticles, loadArticles,
  DEFAULT_CONFIG,
  type CollectorConfig,
  type CollectResult,
} from './collector.js';
import {
  loadCards, saveCards, createCard, updateCard, deleteCard, getCard,
  linkCards, unlinkCards, getBacklinks, getAllTags,
  loadKJGroups, createKJGroup, updateKJGroup, deleteKJGroup, assignKJGroup,
  parseAndImportCSV,
  parseAndImportJSON,
  type Card,
} from './cards_engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    const parsed = rawArticles.map((a: any) => ({ ...a, publishedAt: new Date(a.publishedAt) }));
    const result = await runPipeline(parsed, config, modeId ?? 'custom', options);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ════════════════════════════════════════════════════
//  § A. カードCRUD API
// ════════════════════════════════════════════════════

/** 全カード取得（タグ・KJグループでフィルタ可） */
app.get('/api/cards', (req, res) => {
  let cards = loadCards();
  const { tag, kjGroupId, type, q } = req.query as Record<string, string>;

  if (tag)       cards = cards.filter(c => c.tags.includes(tag));
  if (kjGroupId) cards = cards.filter(c => c.kjGroupId === kjGroupId);
  if (type)      cards = cards.filter(c => c.type === type);
  if (q) {
    const kw = q.toLowerCase();
    cards = cards.filter(c =>
      c.title.toLowerCase().includes(kw) ||
      c.body.toLowerCase().includes(kw) ||
      (c.summary ?? '').toLowerCase().includes(kw) ||
      c.tags.some(t => t.toLowerCase().includes(kw))
    );
  }

  // 降順（新しい順）
  cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(cards);
});

/** カード作成（メモ新規） */
app.post('/api/cards', (req, res) => {
  try {
    const card = createCard({ type: 'memo', ...req.body });
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
app.put('/api/cards/:id', (req, res) => {
  const card = updateCard(req.params.id, req.body);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(card);
});

/** カード削除 */
app.delete('/api/cards/:id', (req, res) => {
  const ok = deleteCard(req.params.id);
  res.json({ ok });
});

// ════════════════════════════════════════════════════
//  § B. AI要約 API
// ════════════════════════════════════════════════════

app.post('/api/cards/:id/summarize', async (req, res) => {
  const card = getCard(req.params.id);
  if (!card) { res.status(404).json({ error: 'Not found' }); return; }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content:
            `以下の記事を日本語で3行以内に要約してください。数字・固有名詞は省略しないでください。\n\n` +
            `タイトル: ${card.title}\n本文: ${card.body}`,
        }],
      }),
    });
    const data = await response.json() as { content: { text: string }[] };
    const summary = data.content?.[0]?.text ?? '';
    const updated = updateCard(card.id, { summary });
    res.json({ summary, card: updated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** 複数カードを一括要約（バックグラウンド） */
app.post('/api/cards/summarize-bulk', async (req, res) => {
  const { ids }: { ids: string[] } = req.body;
  res.json({ ok: true, message: `${ids.length}件の要約を開始しました` });

  // バックグラウンド処理
  (async () => {
    for (const id of ids) {
      const card = getCard(id);
      if (!card || card.summary) continue;
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: `以下の記事を日本語で3行以内に要約してください。\n\nタイトル: ${card.title}\n本文: ${card.body}`,
            }],
          }),
        });
        const data = await resp.json() as { content: { text: string }[] };
        const summary = data.content?.[0]?.text ?? '';
        updateCard(id, { summary });
        await new Promise(r => setTimeout(r, 300)); // レート制限対応
      } catch { /* skip */ }
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
app.post('/api/kj/groups/:id/cards', (req, res) => {
  const { cardId } = req.body as { cardId: string };
  assignKJGroup(cardId, req.params.id);
  res.json({ ok: true });
});

/** カードをグループから外す */
app.delete('/api/kj/groups/:id/cards/:cardId', (req, res) => {
  assignKJGroup(req.params.cardId, null);
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


app.post('/api/cards/import-articles', (req, res) => {
  const { articleIds }: { articleIds?: string[] } = req.body;
  const articles = cachedArticles?.articles ?? [];
  const targets  = articleIds
    ? articles.filter(a => articleIds.includes(a.id))
    : articles;

  const existing = new Set(loadCards().map(c => c.id));
  const imported: Card[] = [];

  for (const a of targets) {
    if (existing.has(`card_from_${a.id}`)) continue;
    const card = createCard({
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
const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`\n  ✓ カード管理サーバー  http://localhost:${PORT}`);
  console.log(`  ✓ GUI                http://localhost:${PORT}/\n`);
});
