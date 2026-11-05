import { describe, expect, it } from "vitest";
import { article, bm25Engine, searchMode, tokenArticle } from "./helpers.js";
import { duplicatePairRecall, numericUnitSearchTerms } from "../bm25_engine.js";

const SEARCH = "\u691c\u7d22";
const IMPLEMENTATION = "\u5b9f\u88c5";
const MEMO = "\u30e1\u30e2";
const COOKING = "\u6599\u7406";
const COFFEE = "\u73c8\u7432";
const IMPORTANT = "\u91cd\u8981";
const CRITICAL = "\u5927\u4e8b";

describe("BM25 search", () => {
  it("normalizes numeric-unit phrases and corrects 憶 only when attached to a number", () => {
    expect(numericUnitSearchTerms(["３憶", "３憶円", "記憶", "3億"])).toEqual(["3億", "3億円"]);
  });

  it("ranks exact and partial matches above unrelated cards", async () => {
    const result = await bm25Engine.runPipeline(
      [
        tokenArticle("exact", "exact search implementation", [SEARCH, IMPLEMENTATION, SEARCH, IMPLEMENTATION]),
        tokenArticle("partial", "partial search", [SEARCH, MEMO]),
        tokenArticle("noise", "cooking memo", [COOKING, COFFEE]),
      ],
      searchMode([
        { term: SEARCH, weight: 2 },
        { term: IMPLEMENTATION, weight: 1 },
      ]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );

    const ids = result.active.map((item: any) => item.article.id);
    expect(ids[0]).toBe("exact");
    expect(ids.indexOf("partial")).toBeGreaterThan(0);
    expect(ids).not.toContain("noise");
  });

  it("does not crash for empty and missing queries", async () => {
    const empty = await bm25Engine.runPipeline(
      [article("a", "sqlite memo", "body")],
      searchMode([]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );
    expect(empty.active).toHaveLength(0);

    const missing = await bm25Engine.runPipeline(
      [article("a", "sqlite memo", "body")],
      searchMode([{ term: "wordthatdoesnotexist", weight: 1 }]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );
    expect(missing.active).toHaveLength(0);
  });

  it("matches numeric-unit phrases from current text when the saved token cache predates them", async () => {
    const staleCache = {
      ...tokenArticle("numeric-target", "年8億円の研究予算", ["年", "研究予算"]),
      body: "研究費は年8億円に達した。",
      morphologicalTokens: ["月", "トークン"],
      ngramTokens: ["月", "トークン"],
      morphologicalDocLength: 2,
      ngramDocLength: 2,
    };
    const result = await bm25Engine.runPipeline(
      [staleCache, tokenArticle("unrelated", "別のメモ", ["億円", "予算"])],
      searchMode([{ term: "８億", weight: 1 }]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );

    expect(result.active.map((item: any) => item.article.id)).toContain("numeric-target");
    expect(result.active.map((item: any) => item.article.id)).not.toContain("unrelated");
  });

  it("reflects keyword weight and synonyms in scores", async () => {
    const result = await bm25Engine.runPipeline(
      [
        tokenArticle("weighted", "weighted implementation", [CRITICAL, IMPLEMENTATION, CRITICAL]),
        tokenArticle("low", "low implementation", [IMPLEMENTATION]),
      ],
      searchMode([
        { term: IMPORTANT, weight: 4, synonyms: [CRITICAL] },
        { term: IMPLEMENTATION, weight: 1 },
      ]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );

    expect(result.active[0].article.id).toBe("weighted");
  });

  it("keeps result count within resultLimit", async () => {
    const result = await bm25Engine.runPipeline(
      Array.from({ length: 20 }, (_, index) =>
        tokenArticle(`limit-${index}`, `limited card ${index}`, [SEARCH, IMPLEMENTATION, String(index)]),
      ),
      searchMode([{ term: SEARCH, weight: 1 }]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 5 },
    );

    expect(result.active.length).toBeLessThanOrEqual(5);
  });

  it("allows offline ranking diagnostics to inspect up to 1000 results", async () => {
    const corpus = Array.from({ length: 501 }, (_, index) =>
      tokenArticle(`diagnostic-${index}`, `diagnostic card ${index}`, [SEARCH, String(index)]),
    );
    const result = await bm25Engine.runPipeline(
      corpus,
      searchMode([{ term: SEARCH, weight: 1 }]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 1000 },
    );

    expect(result.active).toHaveLength(501);
  });

  it("gives higher contribution to weighted keywords than normal keywords", async () => {
    const result = await bm25Engine.runPipeline(
      [
        tokenArticle("weighted-term", "weighted term", [IMPORTANT]),
        tokenArticle("normal-term", "normal term", [IMPLEMENTATION]),
      ],
      searchMode([
        { term: IMPORTANT, weight: 5 },
        { term: IMPLEMENTATION, weight: 1 },
      ]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );

    const weightedScore = result.active.find((item: any) => item.article.id === "weighted-term")?.score ?? 0;
    const normalScore = result.active.find((item: any) => item.article.id === "normal-term")?.score ?? 0;
    expect(weightedScore).toBeGreaterThan(normalScore);
  });

  it("matches synonyms in search results", async () => {
    const result = await bm25Engine.runPipeline(
      [
        tokenArticle("synonym", "synonym term", [CRITICAL]),
        tokenArticle("unrelated", "unrelated term", [MEMO]),
      ],
      searchMode([{ term: IMPORTANT, weight: 2, synonyms: [CRITICAL] }]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 10 },
    );

    expect(result.active.map((item: any) => item.article.id)).toContain("synonym");
    expect(result.active.map((item: any) => item.article.id)).not.toContain("unrelated");
  });

  it("stays under the performance threshold for a moderate corpus", async () => {
    const corpus = Array.from({ length: 250 }, (_, index) =>
      tokenArticle(`perf-${index}`, `search card ${index}`, [SEARCH, IMPLEMENTATION, MEMO, String(index)]),
    );
    const start = performance.now();
    const result = await bm25Engine.runPipeline(
      corpus,
      searchMode([{ term: SEARCH, weight: 1 }, { term: IMPLEMENTATION, weight: 1 }]),
      "acceptance",
      { archiveScoreThreshold: -1, dedupThreshold: 1, resultLimit: 200 },
    );
    const elapsedMs = performance.now() - start;

    expect(result.active.length).toBeGreaterThan(0);
    expect(result.active.length).toBeLessThanOrEqual(200);
    // Threshold includes CI variance while still catching a regression toward per-search tokenization.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("keeps LSH duplicate-pair recall at or above 85 percent", () => {
    const base = Array.from({ length: 24 }, (_, index) => `shared article sentence ${index} about search quality and indexing`).join(". ");
    const corpus = Array.from({ length: 10 }, (_, index) => article(`near-${index}`, `Shared article ${index}`, `${base}. Variant detail ${index}`));
    corpus.push(...Array.from({ length: 10 }, (_, index) => article(`distinct-${index}`, `Distinct article ${index}`, `unrelated topic ${index} with independent content and vocabulary`)));

    expect(duplicatePairRecall(corpus, 0.8)).toBeGreaterThanOrEqual(0.85);
  });
});
