import { beforeEach, describe, expect, it } from "vitest";
import path from 'node:path';
import request from "supertest";
import { app, cardsEngine, database, resetCards, testDir } from "./helpers.js";
import { backfillCardTokens, rebuildSavedCardTokenFts, savedCardTokenFtsStatus } from "../repositories/cards_repository.js";

const db = database.db;

function cardTags(cardId: string) {
  return db.prepare("SELECT card_id, tag FROM card_tags WHERE card_id = ? ORDER BY rowid").all(cardId);
}

function cardLinks(sourceCardId: string) {
  return db.prepare("SELECT source_card_id, target_card_id FROM card_links WHERE source_card_id = ? ORDER BY rowid").all(sourceCardId);
}

describe("card workflows", () => {
  beforeEach(() => {
    resetCards();
  });

  it("creates, reads, updates, and deletes cards", async () => {
    const created = await cardsEngine.createCard({ title: "CRUD card", body: "initial body", tags: ["crud"] });
    const loaded = cardsEngine.getCard(created.id);
    expect(loaded?.title).toBe("CRUD card");
    expect(Number.isNaN(Date.parse(loaded?.createdAt ?? ""))).toBe(false);
    expect(Number.isNaN(Date.parse(loaded?.updatedAt ?? ""))).toBe(false);

    const updated = await cardsEngine.updateCard(created.id, { title: "CRUD card updated" });
    expect(updated?.title).toBe("CRUD card updated");

    expect(cardsEngine.deleteCard(created.id)).toBe(true);
    expect(cardsEngine.getCard(created.id)).toBeNull();
  });

  it("persists both token signals and their document lengths", async () => {
    const created = await cardsEngine.createCard({ title: "未知語検索", body: "日本語の複合語を保存する" });
    const loaded = cardsEngine.getCard(created.id);
    expect(loaded?.morphologicalTokens?.length).toBeGreaterThan(0);
    expect(loaded?.ngramTokens).toEqual(expect.arrayContaining(["未知"]));
    expect(loaded?.morphologicalDocLength).toBe(loaded?.morphologicalTokens?.length);
    expect(loaded?.ngramDocLength).toBe(loaded?.ngramTokens?.length);
  });

  it("backfills only token columns for cards with missing caches", async () => {
    const cached = await cardsEngine.createCard({ title: "Cached", body: "SQLite token cache" });
    const missing = await cardsEngine.createCard({ title: "Missing", body: "日本語トークンを再構築する" });
    const before = db.prepare("SELECT title, body, tags_json, links_json, created_at, updated_at FROM cards WHERE id = ?").get(missing.id);
    db.prepare(`UPDATE cards SET tokens_json='[]', doc_length=0, morphological_tokens_json='[]', ngram_tokens_json='[]',
      morphological_doc_length=0, ngram_doc_length=0 WHERE id=?`).run(missing.id);
    db.exec("CREATE TABLE token_cache_update_audit (id TEXT NOT NULL)");
    db.exec("CREATE TRIGGER token_cache_update_audit_trigger AFTER UPDATE ON cards BEGIN INSERT INTO token_cache_update_audit(id) VALUES (NEW.id); END");
    try {
      expect(await backfillCardTokens()).toBe(1);
      expect(db.prepare("SELECT id FROM token_cache_update_audit").all()).toEqual([{ id: missing.id }]);
      expect(db.prepare("SELECT title, body, tags_json, links_json, created_at, updated_at FROM cards WHERE id = ?").get(missing.id)).toEqual(before);
      expect(cardsEngine.getCard(missing.id)?.morphologicalTokens?.length).toBeGreaterThan(0);
      expect(cardsEngine.getCard(cached.id)?.title).toBe("Cached");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS token_cache_update_audit_trigger; DROP TABLE IF EXISTS token_cache_update_audit");
    }
  });

  it("archives and restores cards", async () => {
    const card = await cardsEngine.createCard({ title: "Archive card", body: "body" });
    cardsEngine.bulkArchiveCards([card.id]);
    expect(cardsEngine.getCard(card.id)?.archived).toBe(true);

    await cardsEngine.restoreCard(card.id);
    expect(Boolean(cardsEngine.getCard(card.id)?.archived)).toBe(false);
  });

  it("bulk archives multiple cards", async () => {
    const first = await cardsEngine.createCard({ title: "Bulk archive A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Bulk archive B", body: "body" });
    const updated = cardsEngine.bulkArchiveCards([first.id, second.id]);

    expect(new Set(updated)).toEqual(new Set([first.id, second.id]));
    expect(cardsEngine.getCard(first.id)?.archived).toBe(true);
    expect(cardsEngine.getCard(second.id)?.archived).toBe(true);
  });

  it("marks the legacy bulk archive endpoint as deprecated", async () => {
    const card = await cardsEngine.createCard({ title: "Legacy bulk archive", body: "body" });

    const response = await request(app)
      .post("/api/cards/archive-bulk")
      .send({ ids: [card.id] });

    expect(response.status).toBe(200);
    expect(response.headers.deprecation).toBe("true");
    expect(cardsEngine.getCard(card.id)?.archived).toBe(true);
  });

  it("bulk deletes cards and removes link references", async () => {
    const first = await cardsEngine.createCard({ title: "Bulk delete A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Bulk delete B", body: "body" });
    const third = await cardsEngine.createCard({ title: "Bulk delete C", body: "body" });
    cardsEngine.linkCards(first.id, second.id);
    cardsEngine.linkCards(third.id, second.id);

    expect(cardsEngine.bulkDeleteCards([second.id])).toEqual([second.id]);
    expect(cardsEngine.getCard(second.id)).toBeNull();
    expect(cardsEngine.getCard(first.id)?.links).not.toContain(second.id);
    expect(cardsEngine.getCard(third.id)?.links).not.toContain(second.id);
  });

  it("adds, removes, and searches tags", async () => {
    const card = await cardsEngine.createCard({ title: "Tag card", body: "body", tags: ["alpha"] });
    expect(cardsEngine.getCards({ tag: "alpha" })).toHaveLength(1);

    await cardsEngine.updateCard(card.id, { tags: ["beta"] });
    expect(cardsEngine.getCards({ tag: "alpha" })).toHaveLength(0);
    expect(cardsEngine.getCards({ tag: "beta" })).toHaveLength(1);
    expect(cardsEngine.getCards({ q: "beta" })).toHaveLength(1);
  });

  it("supports the optional SQLite FTS5 card search path", async () => {
    const card = await cardsEngine.createCard({ title: "FTS5 architecture", body: "full text search", tags: ["indexed"] });
    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5";
    try {
      expect(cardsEngine.getCards({ q: "FTS5" }).map(item => item.id)).toContain(card.id);
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("uses morphology-only FTS5 by default for saved-card search", async () => {
    const matching = await cardsEngine.createCard({ title: "SQLite WAL concurrency", body: "Writers use a lock while readers continue." });
    await cardsEngine.createCard({ title: "Unrelated gardening note", body: "Tomatoes need sunlight." });
    const previous = process.env.CARD_SEARCH_ENGINE;
    delete process.env.CARD_SEARCH_ENGINE;
    try {
      const response = await request(app).post("/api/cards/search").send({
      config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "SQLite", weight: 1 }] },
      options: { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 10 },
      filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(response.status).toBe(200);
      expect(response.body.scope).toMatchObject({ corpus: "cards", searchMethod: "fts5-morph-saved-cards", totalCount: 2, searchedCount: 2 });
      expect(response.body.active[0]?.article?.id, JSON.stringify(response.body)).toBe(matching.id);
      expect(response.body.active[0].matchedKeywords).toContain("SQLite");
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("captures pre-rerank candidates only in explicit private evaluation mode", async () => {
    const matching = await cardsEngine.createCard({ title: "Candidate capture SQLite", body: "private evaluation fixture" });
    const previousCapture = process.env.PERSONAL_REFIND_EVAL_CAPTURE;
    const previousEngine = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = 'fts5-morph';
    delete process.env.PERSONAL_REFIND_EVAL_CAPTURE;
    const body = { config: { label: 'test', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5,
      keywords: [{ term: 'Candidate capture SQLite', weight: 1 }] },
      options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 10 },
      filters: { excludedTerms: [], sources: [], status: 'all' } };
    try {
      const normal = await request(app).post('/api/cards/search').send(body);
      expect(normal.status).toBe(200);
      expect(normal.body.scope).not.toHaveProperty('candidateIdsBeforeRerank');
      process.env.PERSONAL_REFIND_EVAL_CAPTURE = '1';
      const evaluation = await request(app).post('/api/cards/search').send(body);
      expect(evaluation.status).toBe(200);
      expect(evaluation.body.scope.candidateIdsBeforeRerank).toContain(matching.id);
    } finally {
      if (previousEngine === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previousEngine;
      if (previousCapture === undefined) delete process.env.PERSONAL_REFIND_EVAL_CAPTURE;
      else process.env.PERSONAL_REFIND_EVAL_CAPTURE = previousCapture;
    }
  });

  it("falls back to BM25 when the opt-in E5 model is unavailable", async () => {
    const matching = await cardsEngine.createCard({ title: "SQLite WAL lock", body: "Writers serialize through the database lock." });
    await cardsEngine.createCard({ title: "Garden notes", body: "Tomatoes need sunlight." });
    const previousEngine = process.env.CARD_SEARCH_ENGINE;
    const previousModelCache = process.env.E5_MODEL_CACHE_DIR;
    process.env.CARD_SEARCH_ENGINE = 'e5-rrf';
    process.env.E5_MODEL_CACHE_DIR = path.join(testDir, 'missing-e5-model');
    try {
      const response = await request(app).post('/api/cards/search').send({
        config: { label: 'test', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: 'SQLite WAL lock', weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: 'all' },
      });
      expect(response.status).toBe(200);
      expect(response.body.scope).toMatchObject({ searchMethod: 'bm25-e5-fallback-saved-cards', fallbackUsed: true });
      expect(response.body.active[0].article.id).toBe(matching.id);
      expect(response.body.stats.modeUsed).not.toBe('bm25-e5-rrf');
    } finally {
      if (previousEngine === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previousEngine;
      if (previousModelCache === undefined) delete process.env.E5_MODEL_CACHE_DIR;
      else process.env.E5_MODEL_CACHE_DIR = previousModelCache;
    }
  });

  it.skipIf(process.env.RUN_E5_MODEL_INTEGRATION !== '1')('uses a prepared local E5 model in the saved-card API path', async () => {
    const previousEngine = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = 'e5-rrf';
    try {
      await cardsEngine.createCard({ title: 'SQLite WAL concurrency', body: 'SQLite serializes writers while readers continue under WAL.' });
      await cardsEngine.createCard({ title: 'Garden notes', body: 'Tomatoes need sunlight and regular watering.' });
      const response = await request(app).post('/api/cards/search').send({
        config: { label: 'test', description: '', k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: 'SQLite writer lock WAL', weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: 'all' },
      });
      expect(response.status).toBe(200);
      expect(response.body.scope).toMatchObject({ searchMethod: 'bm25-e5-rrf-saved-cards', fallbackUsed: false });
      expect(response.body.active[0].scoreSources).toMatchObject({ method: 'bm25-e5-rrf', model: 'multilingual-e5-small' });
      expect(response.body.stats.timings.e5RerankMs).toBeGreaterThan(0);
    } finally {
      if (previousEngine === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previousEngine;
    }
  });

  it("uses persistent morphology, ngram, and raw-field FTS5 ranks for saved-card search", async () => {
    const matching = await cardsEngine.createCard({
      title: "SQLite concurrency",
      body: "Writers serialize through the database lock.",
      summary: "rare-summary-term",
      tags: ["wal-index-tag"],
    });
    await cardsEngine.createCard({ title: "Unrelated gardening note", body: "Tomatoes need sunlight." });
    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5";
    const body = {
      config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "SQLite", weight: 1 }] },
      options: { dedupThreshold: 1, archiveScoreThreshold: -1, resultLimit: 10 },
      filters: { excludedTerms: [], sources: [], status: "all" },
    };
    try {
      const response = await request(app).post("/api/cards/search").send(body);
      expect(response.status).toBe(200);
      expect(response.body.scope).toMatchObject({ corpus: "cards", searchMethod: "fts5-rrf-saved-cards", totalCount: 2, candidateCount: 1 });
      expect(savedCardTokenFtsStatus()).toMatchObject({ ready: true, cards: 2, morphological: 2, ngram: 2, raw: 2 });
      expect(response.body.active[0].article.id).toBe(matching.id);
      expect(response.body.active[0].scoreSources).toMatchObject({ method: "sqlite-fts5-rrf", reciprocalRankConstant: 60 });

      const summarySearch = await request(app).post("/api/cards/search").send({
        ...body,
        config: { ...body.config, keywords: [{ term: "rare-summary-term", weight: 1 }] },
      });
      expect(summarySearch.status).toBe(200);
      expect(summarySearch.body.active[0]?.article?.id).toBe(matching.id);

      const excludedSearch = await request(app).post("/api/cards/search").send({
        ...body,
        filters: { ...body.filters, excludedTerms: ["Writers serialize"] },
      });
      expect(excludedSearch.status).toBe(200);
      expect(excludedSearch.body.active).toHaveLength(0);

      await cardsEngine.updateCard(matching.id, { title: "Renamed database note", body: "New content only." });
      const stale = await request(app).post("/api/cards/search").send(body);
      expect(stale.status).toBe(200);
      expect(stale.body.active).toHaveLength(0);

      await cardsEngine.updateCard(matching.id, { title: "SQLite restored" });
      expect(cardsEngine.deleteCard(matching.id)).toBe(true);
      const deleted = await request(app).post("/api/cards/search").send(body);
      expect(deleted.status).toBe(200);
      expect(deleted.body.active).toHaveLength(0);
      expect(rebuildSavedCardTokenFts()).toBe(1);
      expect(savedCardTokenFtsStatus()).toMatchObject({ ready: true, cards: 1, morphological: 1, ngram: 1, raw: 1 });
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("exposes raw-text FTS5 BM25 as an opt-in saved-card comparison mode", async () => {
    const matching = await cardsEngine.createCard({
      title: "SQLite WAL writer lock",
      body: "Concurrent writes are serialized by SQLite.",
      tags: ["database"],
    });
    await cardsEngine.createCard({ title: "Garden notes", body: "Water the tomatoes every morning." });
    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5-raw";
    try {
      const response = await request(app).post("/api/cards/search").send({
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "SQLite", weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0.5, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(response.status).toBe(200);
      expect(response.body.scope.searchMethod).toBe("fts5-raw-saved-cards");
      expect(response.body.active[0]?.article?.id).toBe(matching.id);
      expect(response.body.active[0]?.scoreSources).toMatchObject({ method: "sqlite-fts5-raw-bm25", rawTextRank: 1 });
      expect(response.body.active[0]?.score).toBe(1);
      expect(response.body.active[0]?.breakdown?.tokenWeights).toEqual({ morphological: 0, ngram: 0, rawText: 1 });
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("finds full-width numeric-unit queries with a common unit homophone typo without rebuilding the FTS index", async () => {
    const matching = await cardsEngine.createCard({
      title: "年3億円の研究予算",
      body: "研究費は年3億円に達した。",
    });
    const fullWidthCase = await cardsEngine.createCard({ title: "月5億円分のトークン", body: "トークン利用額の話。" });
    await cardsEngine.createCard({ title: "別のメモ", body: "億円と予算について。" });
    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5-morph";
    try {
      const response = await request(app).post("/api/cards/search").send({
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "３憶", weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(response.status).toBe(200);
      expect(response.body.scope).toMatchObject({
        searchMethod: "numeric-phrase-scan-saved-cards",
        directNumericPhraseFallback: true,
        fallbackUsed: true,
      });
      expect(response.body.active[0]?.article?.id).toBe(matching.id);
      expect(response.body.scope.totalCount).toBe(3);
      expect(savedCardTokenFtsStatus()).toMatchObject({ ready: true, cards: 3 });

      const fullWidthBillion = await request(app).post("/api/cards/search").send({
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "５億", weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(fullWidthBillion.status).toBe(200);
      expect(fullWidthBillion.body.active[0]?.article?.id).toBe(fullWidthCase.id);

      const fullWidthDigitOnly = await request(app).post("/api/cards/search").send({
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "３億", weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(fullWidthDigitOnly.status).toBe(200);
      expect(fullWidthDigitOnly.body.active[0]?.article?.id).toBe(matching.id);
      expect(fullWidthDigitOnly.body.scope.directNumericPhraseFallback).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("finds a saved article through the natural-query API when ２憶 is intended as 2億", async () => {
    const matching = await cardsEngine.createCard({
      title: "どうすれば月2億円分のトークンを燃やせるのか",
      body: "月あたり2億円分のトークンを使う方法について。",
    });
    const parsed = await request(app).post("/api/search/terms").send({ text: "２憶" });
    expect(parsed.status).toBe(200);
    expect(parsed.body.keywords.map((keyword: { term: string }) => keyword.term)).toContain("2億");

    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5-morph";
    try {
      const response = await request(app).post("/api/cards/search").send({
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: parsed.body.keywords },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(response.status).toBe(200);
      expect(response.body.active[0]?.article?.id).toBe(matching.id);
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("applies the card list filters to ranked saved-card search", async () => {
    const matching = await cardsEngine.createCard({ title: "Orbital mechanics note", body: "Orbital transfer", tags: ["keep"], type: "memo" });
    await cardsEngine.createCard({ title: "Orbital article", body: "Orbital transfer", tags: ["other"], type: "article" });
    const archived = await cardsEngine.createCard({ title: "Old orbital memo", body: "Orbital transfer", tags: ["keep"], type: "memo" });
    cardsEngine.bulkArchiveCards([archived.id]);

    const body = {
      config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1, keywords: [{ term: "orbital", weight: 1 }] },
      options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 10 },
      filters: { excludedTerms: [], sources: [], status: "all" },
      cardFilters: { tag: "keep", type: "memo", archived: false },
    };
    const response = await request(app).post("/api/cards/search").send(body);

    expect(response.status).toBe(200);
    expect(response.body.active.map((item: { article: { id: string } }) => item.article.id)).toEqual([matching.id]);

    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "like";
    try {
      const fallback = await request(app).post("/api/cards/search").send(body);
      expect(fallback.status).toBe(200);
      expect(fallback.body.active.map((item: { article: { id: string } }) => item.article.id)).toEqual([matching.id]);
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("continues numeric-phrase fallback pagination past excluded archived cards", async () => {
    const first = await cardsEngine.createCard({ title: "月5億円の利用例A", body: "トークンの利用例。" });
    const second = await cardsEngine.createCard({ title: "月5億円の利用例B", body: "トークンの利用例。" });
    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5-morph";
    try {
      const body = {
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1, keywords: [{ term: "５憶", weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0, resultLimit: 1 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      };
      const beforeArchive = await request(app).post("/api/cards/search").send(body);
      expect(beforeArchive.status).toBe(200);
      expect(beforeArchive.body.scope.directNumericPhraseFallback).toBe(true);
      const firstRankedId = beforeArchive.body.active[0]?.article?.id;
      if (typeof firstRankedId !== "string") throw new Error("Expected a numeric phrase result");
      expect([first.id, second.id]).toContain(firstRankedId);
      const remainingId = firstRankedId === first.id ? second.id : first.id;
      cardsEngine.bulkArchiveCards([firstRankedId]);

      const afterArchive = await request(app).post("/api/cards/search").send({ ...body, cardFilters: { archived: false } });
      expect(afterArchive.status).toBe(200);
      expect(afterArchive.body.active.map((item: { article: { id: string } }) => item.article.id)).toEqual([remainingId]);
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("exposes morphology-only FTS5 BM25 as an opt-in saved-card comparison mode", async () => {
    const matching = await cardsEngine.createCard({
      title: "SQLite concurrency control",
      body: "The database serializes concurrent writers with a lock.",
      tags: ["database"],
    });
    await cardsEngine.createCard({ title: "Garden notes", body: "Water the tomatoes every morning." });
    const previous = process.env.CARD_SEARCH_ENGINE;
    process.env.CARD_SEARCH_ENGINE = "fts5-morph";
    try {
      const response = await request(app).post("/api/cards/search").send({
        config: { label: "test", description: "", k1: 1.5, b: 0.75, lambda: 0, contextBonus: 1.5, keywords: [{ term: "SQLite", weight: 1 }] },
        options: { dedupThreshold: 1, archiveScoreThreshold: 0.5, resultLimit: 10 },
        filters: { excludedTerms: [], sources: [], status: "all" },
      });

      expect(response.status).toBe(200);
      expect(response.body.scope.searchMethod).toBe("fts5-morph-saved-cards");
      expect(response.body.scope.fallbackUsed).toBe(false);
      expect(response.body.active[0]?.article?.id).toBe(matching.id);
      expect(response.body.active[0]?.scoreSources).toMatchObject({ method: "sqlite-fts5-morphological-bm25", morphologicalRank: 1 });
      expect(response.body.active[0]?.score).toBe(1);
      expect(response.body.active[0]?.breakdown?.tokenWeights).toEqual({ morphological: 1, ngram: 0, rawText: 0 });
    } finally {
      if (previous === undefined) delete process.env.CARD_SEARCH_ENGINE;
      else process.env.CARD_SEARCH_ENGINE = previous;
    }
  });

  it("keeps similar but distinct saved cards in search unless deduplication is explicitly requested", async () => {
    const purchased = await cardsEngine.createCard({
      title: "",
      body: "購入した材料・部品についても、輸出する産品と同様、当該材料・部品に適用される原産地規則を満たしていれば原産品として扱うことができます。",
    });
    const inHouse = await cardsEngine.createCard({
      title: "",
      body: "自社で内製した材料・部品についても、輸出する産品と同様、当該材料・部品に適用される原産地規則を満たしていれば原産品として扱うことができます。",
    });
    const body = {
      config: {
        label: "FAQ search",
        description: "",
        k1: 1.2,
        b: 0.5,
        lambda: 0,
        contextBonus: 1.5,
        keywords: ["購入", "材料", "部品", "原産"].map(term => ({ term, weight: 1 })),
      },
      options: { archiveScoreThreshold: -1, resultLimit: 10 },
      filters: { excludedTerms: [], sources: [], status: "all" },
    };

    const defaultSearch = await request(app).post("/api/cards/search").send(body);
    expect(defaultSearch.status).toBe(200);
    expect(defaultSearch.body.active.map((item: { article: { id: string } }) => item.article.id)).toEqual(
      expect.arrayContaining([purchased.id, inHouse.id]),
    );

    const explicitDedup = await request(app).post("/api/cards/search").send({
      ...body,
      options: { ...body.options, dedupThreshold: 0.8 },
    });
    expect(explicitDedup.status).toBe(200);
    expect(explicitDedup.body.active.map((item: { article: { id: string } }) => item.article.id)).toHaveLength(1);
  });

  it("stores tags in card_tags when cards are created", async () => {
    const card = await cardsEngine.createCard({ title: "Tag junction create", body: "body", tags: ["alpha", "beta"] });

    expect(cardTags(card.id)).toEqual([
      { card_id: card.id, tag: "alpha" },
      { card_id: card.id, tag: "beta" },
    ]);
  });

  it("replaces old tag relations when tags are updated", async () => {
    const card = await cardsEngine.createCard({ title: "Tag junction update", body: "body", tags: ["old"] });

    await cardsEngine.updateCard(card.id, { tags: ["new"] });

    expect(cardTags(card.id)).toEqual([{ card_id: card.id, tag: "new" }]);
    expect(cardsEngine.getCards({ tag: "old" })).toHaveLength(0);
    expect(cardsEngine.getCards({ tag: "new" })).toHaveLength(1);
  });

  it("removes tag relations when tags are cleared", async () => {
    const card = await cardsEngine.createCard({ title: "Tag junction clear", body: "body", tags: ["remove-me"] });

    await cardsEngine.updateCard(card.id, { tags: [] });

    expect(cardTags(card.id)).toEqual([]);
    expect(cardsEngine.getCard(card.id)?.tags).toEqual([]);
  });

  it("returns backlinks when A links to B", async () => {
    const first = await cardsEngine.createCard({ title: "Backlink A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Backlink B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    expect(cardsEngine.getBacklinks(second.id).some((card: any) => card.id === first.id)).toBe(true);
  });

  it("stores Zettelkasten links in card_links", async () => {
    const first = await cardsEngine.createCard({ title: "Link junction A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Link junction B", body: "body" });

    cardsEngine.linkCards(first.id, second.id);

    expect(cardLinks(first.id)).toContainEqual({ source_card_id: first.id, target_card_id: second.id });
    expect(cardLinks(second.id)).toEqual([]);
  });

  it("rejects self links through the API", async () => {
    const card = await cardsEngine.createCard({ title: "Self link", body: "body" });

    const response = await request(app)
      .post(`/api/cards/${card.id}/links`)
      .send({ targetId: card.id });

    expect(response.status).toBe(400);
    expect(cardLinks(card.id)).toEqual([]);
  });

  it("does not duplicate link rows when the same link is added twice", async () => {
    const first = await cardsEngine.createCard({ title: "Duplicate link A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Duplicate link B", body: "body" });

    cardsEngine.linkCards(first.id, second.id);
    cardsEngine.linkCards(first.id, second.id);

    expect(cardLinks(first.id).filter((link: any) => link.target_card_id === second.id)).toHaveLength(1);
    expect(cardLinks(second.id).filter((link: any) => link.target_card_id === first.id)).toHaveLength(0);
  });

  it("removes link rows when cards are unlinked", async () => {
    const first = await cardsEngine.createCard({ title: "Unlink A", body: "body" });
    const second = await cardsEngine.createCard({ title: "Unlink B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    cardsEngine.unlinkCards(first.id, second.id);

    expect(cardLinks(first.id)).toEqual([]);
    expect(cardLinks(second.id)).toEqual([]);
    expect(cardsEngine.getBacklinks(second.id)).toHaveLength(0);
  });

  it("persists tags and links through junction tables", async () => {
    const first = await cardsEngine.createCard({ title: "Junction A", body: "body", tags: ["junction", "db"] });
    const second = await cardsEngine.createCard({ title: "Junction B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    expect(cardsEngine.getCard(first.id)?.tags).toEqual(["junction", "db"]);
    expect(cardsEngine.getCard(first.id)?.links).toContain(second.id);
    expect(cardsEngine.getAllTags().some(({ tag, count }) => tag === "junction" && count === 1)).toBe(true);

    await cardsEngine.updateCard(first.id, { tags: ["normalized"] });
    expect(cardsEngine.getCard(first.id)?.tags).toEqual(["normalized"]);
    expect(cardsEngine.getCards({ tag: "junction" })).toHaveLength(0);
    expect(cardsEngine.getCards({ tag: "normalized" })).toHaveLength(1);
  });

  it("removes tag and link relations when a card is deleted", async () => {
    const first = await cardsEngine.createCard({ title: "Delete relation A", body: "body", tags: ["delete-tag"] });
    const second = await cardsEngine.createCard({ title: "Delete relation B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    cardsEngine.deleteCard(second.id);

    expect(cardLinks(first.id)).toEqual([]);
    expect(cardsEngine.getCard(first.id)?.links).toEqual([]);

    cardsEngine.deleteCard(first.id);
    expect(cardTags(first.id)).toEqual([]);
  });

  it("bulk delete removes related tag and link rows", async () => {
    const first = await cardsEngine.createCard({ title: "Bulk relation A", body: "body", tags: ["bulk-tag"] });
    const second = await cardsEngine.createCard({ title: "Bulk relation B", body: "body", tags: ["bulk-tag-2"] });
    const third = await cardsEngine.createCard({ title: "Bulk relation C", body: "body" });
    cardsEngine.linkCards(third.id, first.id);
    cardsEngine.linkCards(third.id, second.id);

    cardsEngine.bulkDeleteCards([first.id, second.id]);

    expect(cardTags(first.id)).toEqual([]);
    expect(cardTags(second.id)).toEqual([]);
    expect(cardLinks(third.id)).toEqual([]);
    expect(cardsEngine.getCard(third.id)?.links).toEqual([]);
  });

  it("keeps API responses compatible with tags and links arrays", async () => {
    const first = await cardsEngine.createCard({ title: "API relation A", body: "body", tags: ["api-tag"] });
    const second = await cardsEngine.createCard({ title: "API relation B", body: "body" });
    cardsEngine.linkCards(first.id, second.id);

    const response = await request(app).get(`/api/cards/${first.id}`);

    expect(response.status).toBe(200);
    expect(response.body.tags).toEqual(["api-tag"]);
    expect(response.body.links).toContain(second.id);
  });

  it("creates, updates, assigns, and deletes KJ groups", async () => {
    const card = await cardsEngine.createCard({ title: "KJ card", body: "body" });
    const group = cardsEngine.createKJGroup("Group A", "description");
    expect(cardsEngine.loadKJGroups()).toHaveLength(1);

    const updated = cardsEngine.updateKJGroup(group.id, { name: "Group B" });
    expect(updated?.name).toBe("Group B");

    await cardsEngine.assignKJGroup(card.id, group.id);
    expect(cardsEngine.getCard(card.id)?.kjGroupId).toBe(group.id);

    cardsEngine.deleteKJGroup(group.id);
    expect(cardsEngine.loadKJGroups()).toHaveLength(0);
    expect(cardsEngine.getCard(card.id)?.kjGroupId).toBeUndefined();
  });
});
