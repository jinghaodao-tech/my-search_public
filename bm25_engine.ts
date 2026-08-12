/**
 * bm25_engine.ts
 * デジタル・コモンズ 自律収集システム — BM25スコアリングエンジン
 *
 * 依存:  npm install kuromoji
 * 実行:  npx tsx bm25_engine.ts
 * ビルド: tsc bm25_engine.ts --target ES2022 --module Node16 --moduleResolution Node16
 *
 * kuromoji の辞書パスは環境に合わせて DICT_PATH を変更してください。
 * node_modules/kuromoji/dict/ が標準のパスです。
 */

import kuromoji from "kuromoji";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════
//  § 1. 型定義
// ═══════════════════════════════════════════════════════════════════

interface KeywordWeight {
  term: string;
  weight: number;        // W_i : モード設定での重み
  synonyms?: string[];   // 表記揺れを代表語に統合
}

export interface ModeConfig {
  label: string;
  description: string;
  k1: number;            // BM25 飽和速度 (推奨: 0.5–3.0)
  b: number;             // BM25 文書長補正 (推奨: 0–1)
  lambda: number;        // 時間減衰 λ (大きいほど古い記事が急落)
  contextBonus: number;  // Context bonus 上限 (キーワード共起ボーナス)
  keywords: KeywordWeight[];
  morphologicalWeight?: number;
  ngramWeight?: number;
}

interface ModesConfig {
  [modeId: string]: ModeConfig;
}

export interface Article {
  id: string;
  title: string;
  body: string;
  publishedAt: Date;
  sourceAuthority: number; // 0–1 : ソースの信頼度
  url: string;
  source?: string | null;
  tokens?: string[];
  docLength?: number;
  morphologicalTokens?: string[];
  ngramTokens?: string[];
  morphologicalDocLength?: number;
  ngramDocLength?: number;
  summary?: string;
  tags?: string[];
  type?: string;
  createdAt?: string;
  firstSeenAt?: string;
  updatedAt?: string;
  archived?: boolean;
  archivedAt?: string;
}

interface ScoredArticle {
  article: Article;
  score: number;
  breakdown: ScoreBreakdown;
}

interface ScoreBreakdown {
  bm25Raw: number;
  bm25Morphological: number;
  bm25Ngram: number;
  normalizedMorphological: number;
  normalizedNgram: number;
  tokenWeights: { morphological: number; ngram: number };
  contextBonus: number;
  timeDecay: number;
  finalScore: number;
  matchedTerms: MatchedTerm[];
}

interface MatchedTerm {
  term: string;
  tf: number;
  idf: number;
  bm25: number;
  weight: number;
  contribution: number;
}

interface CorpusStats {
  docCount: number;
  morphologicalStats?: { avgDocLength: number; termDocFreq: Map<string, number> };
  ngramStats?: { avgDocLength: number; termDocFreq: Map<string, number> };
  avgDocLength: number;
  termDocFreq: Map<string, number>; // term → 出現文書数
}

export interface PipelineResult {
  active: ScoredArticle[];
  belowThreshold: Array<{ article: Article; reason: string }>;
  /** @deprecated Use belowThreshold. */
  archived: Array<{ article: Article; reason: string }>;
  stats: {
    inputCount: number;
    afterDedup: number;
    activeCount: number;
    archivedCount: number;
    modeUsed: string;
    avgScore: number;
    timings?: BenchmarkTimings;
  };
}

interface ArchiveDecision {
  shouldArchive: boolean;
  reason: string;
}

export interface BenchmarkTimings {
  dbLoadMs?: number;
  tokenPreparationMs: number;
  scoringMs: number;
  sortingLimitMs: number;
  totalSearchMs: number;
}

function nowMs(): number {
  return performance.now();
}

// ═══════════════════════════════════════════════════════════════════
//  § 2. モード設定
//       GUI の「TS config 出力」結果をここに貼り替えるだけで反映される
// ═══════════════════════════════════════════════════════════════════

export const MODES: ModesConfig = {
  impl: {
    label: "実装",
    description: "コード・ドキュメント中心。短文多め、時間減衰緩め。",
    k1: 1.2,
    b: 0.5,
    lambda: 0.05,
    contextBonus: 1.5,
    morphologicalWeight: 0.75,
    ngramWeight: 0.25,
    keywords: [
      { term: "実装",         weight: 2.0, synonyms: ["implementation", "コード", "code"] },
      { term: "github",       weight: 1.8, synonyms: ["pr", "pullrequest", "コミット", "commit"] },
      { term: "ライブラリ",    weight: 1.6, synonyms: ["パッケージ", "package", "npm", "pip"] },
      { term: "バグ",         weight: 1.4, synonyms: ["エラー", "error", "exception", "例外"] },
      { term: "パフォーマンス", weight: 1.2, synonyms: ["速度", "最適化", "optimization"] },
      { term: "理論",         weight: 0.5, synonyms: ["数式", "定理"] },
      { term: "潮流",         weight: 0.4, synonyms: ["動向", "トレンド"] },
    ],
  },

  theory: {
    label: "理論",
    description: "論文・書籍対象。長文正規化強め、古典論文も高評価。",
    k1: 1.8,
    b: 0.8,
    lambda: 0.02,
    contextBonus: 2.2,
    morphologicalWeight: 0.35,
    ngramWeight: 0.65,
    keywords: [
      { term: "定理",     weight: 2.0, synonyms: ["theorem", "補題", "lemma", "命題"] },
      { term: "arxiv",    weight: 1.9, synonyms: ["論文", "paper", "preprint"] },
      { term: "証明",     weight: 1.7, synonyms: ["proof", "仮説", "hypothesis"] },
      { term: "引用",     weight: 1.4, synonyms: ["参考文献", "reference", "citation"] },
      { term: "実装",     weight: 0.6, synonyms: ["コード"] },
      { term: "ニュース",  weight: 0.3, synonyms: ["動向"] },
    ],
  },

  trend: {
    label: "潮流",
    description: "ブログ・ニュース対象。時間減衰強め、固有表現優先。",
    k1: 1.5,
    b: 0.75,
    lambda: 0.15,
    contextBonus: 1.8,
    morphologicalWeight: 0.35,
    ngramWeight: 0.65,
    keywords: [
      { term: "リリース",   weight: 2.0, synonyms: ["発表", "launch", "announce"] },
      { term: "プロダクト", weight: 1.9, synonyms: ["サービス", "product", "service"] },
      { term: "市場",      weight: 1.5, synonyms: ["業界", "industry", "market"] },
      { term: "資金調達",   weight: 1.3, synonyms: ["funding", "シリーズ", "ipo"] },
      { term: "数式",      weight: 0.3, synonyms: ["定理"] },
      { term: "古典",      weight: 0.2, synonyms: [] },
    ],
  },
};

let activeModeId: string = "impl";

function setActiveMode(modeId: string): void {
  if (!(modeId in MODES)) throw new Error(`Unknown mode: ${modeId}`);
  activeModeId = modeId;
}

function getActiveMode(): ModeConfig {
  return MODES[activeModeId]!;
}

// ═══════════════════════════════════════════════════════════════════
//  § 3. Tokenizer — kuromoji による形態素解析 + 類義語展開
// ═══════════════════════════════════════════════════════════════════

// kuromoji.Tokenizer の型がパッケージに含まれないため手動定義
type KuromojiToken = {
  surface_form: string;
  pos: string;             // 品詞
  pos_detail_1: string;
  reading?: string;
  base_form?: string;
};
type KuromojiTokenizer = {
  tokenize(text: string): KuromojiToken[];
};

// 品詞フィルタ: 名詞・動詞・形容詞・外来語のみ残す
const KEEP_POS = new Set(["名詞", "動詞", "形容詞", "感動詞"]);

// kuromoji は非同期初期化が必要なためシングルトンで保持
const JAPANESE_CHAR = /[\u3040-\u30ff\u3400-\u9fff]/u;
const MOJIBAKE_PATTERNS = [/\uFFFD/u, /Ã./u, /Â./u, /ã./u, /繧/u, /縺/u, /譁/u];

export function looksLikeMojibake(value: string): boolean {
  return MOJIBAKE_PATTERNS.some((pattern) => pattern.test(value));
}

type KeywordGroup = string[];

export function expandJapaneseTokens(tokens: string[]): string[] {
  const expanded = new Set<string>();
  for (const rawToken of tokens) {
    const token = rawToken.normalize("NFKC").toLowerCase().trim();
    if (!token) continue;
    expanded.add(token);
    if (!JAPANESE_CHAR.test(token) || Array.from(token).length < 2) continue;
    const chars = Array.from(token);
    for (let index = 0; index < chars.length - 1; index += 1) {
      expanded.add(chars.slice(index, index + 2).join(""));
    }
  }
  return [...expanded];
}

export function computeJapanesePhraseWeight(baseWeight: number, tokenCount: number): number {
  if (tokenCount <= 1) return baseWeight;
  return Math.min(baseWeight * (1 + Math.min(tokenCount - 1, 4) * 0.125), 3);
}

let _tokenizer: KuromojiTokenizer | null = null;
let _tokenizerPromise: Promise<KuromojiTokenizer> | null = null;

const DICT_PATH = path.join(__dirname, "node_modules/kuromoji/dict/");

async function getTokenizer(): Promise<KuromojiTokenizer> {
  if (_tokenizer) return _tokenizer;
  if (_tokenizerPromise) return _tokenizerPromise;
  _tokenizerPromise = new Promise((resolve, reject) => {
    kuromoji
      .builder({ dicPath: DICT_PATH })
      .build((err: Error | null, tokenizer: KuromojiTokenizer) => {
        if (err) {
          _tokenizerPromise = null;
          return reject(err);
        }
        _tokenizer = tokenizer;
        resolve(tokenizer);
      });
  });
  return _tokenizerPromise;
}

/**
 * テキストを形態素解析してトークン列を返す。
 * - 名詞・動詞・形容詞のみ抽出（助詞・助動詞を除去）
 * - base_form（基本形）に正規化することで活用ゆれを吸収
 * - NFKC 正規化で全角→半角統一
 */
export async function tokenizeMorphological(text: string): Promise<string[]> {
  const tokenizer = await getTokenizer();
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = tokenizer.tokenize(normalized);

  const morphologicalTokens = tokens
    .filter((t) => KEEP_POS.has(t.pos))
    .map((t) => (t.base_form ?? t.surface_form).toLowerCase())
    .filter((t) => t.length > 1);
  return morphologicalTokens;
}

export async function tokenize(text: string): Promise<string[]> {
  return expandJapaneseTokens(await tokenizeMorphological(text));
}

export async function tokenizeNgram(text: string): Promise<string[]> {
  return tokenize(text);
}

export type StoredTokenSet = {
  morphologicalTokens: string[];
  ngramTokens: string[];
  morphologicalDocLength: number;
  ngramDocLength: number;
};

export async function buildStoredTokenSet(text: string): Promise<StoredTokenSet> {
  const morphologicalTokens = await tokenizeMorphological(text);
  const ngramSet = new Set(expandJapaneseTokens(morphologicalTokens));
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const sequence of normalized.matchAll(/[\u3040-\u30ff\u3400-\u9fff]{2,}/gu)) {
    const chars = Array.from(sequence[0]);
    for (let index = 0; index < chars.length - 1; index += 1) ngramSet.add(chars.slice(index, index + 2).join(""));
  }
  const ngramTokens = [...ngramSet];
  return {
    morphologicalTokens,
    ngramTokens,
    morphologicalDocLength: morphologicalTokens.length,
    ngramDocLength: ngramTokens.length,
  };
}

/**
 * keywords の term と synonyms を正規化して
 * synonym → canonical（代表語）マップを構築。
 * kuromoji で解析して base_form を使うことで
 * 「実装する」「実装した」などの活用ゆれも代表語に統一できる。
 */
async function buildSynonymMap(
  keywords: KeywordWeight[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const kw of keywords) {
    const canonicalTokens = await tokenize(kw.term);
    const canonical = canonicalTokens[0] ?? kw.term.toLowerCase();
    map.set(canonical, canonical);
    for (const syn of kw.synonyms ?? []) {
      for (const tok of await tokenize(syn)) {
        map.set(tok, canonical);
      }
      // ASCII のまま入ってくるケースにも対応
      map.set(syn.toLowerCase(), canonical);
    }
  }
  return map;
}

async function buildKeywordWeightMap(
  keywords: KeywordWeight[],
  synonymMap: Map<string, string>,
  corpus: CorpusStats
): Promise<Map<string, number>> {
  const weights = new Map<string, number>();
  for (const kw of keywords) {
    const terms = [kw.term, ...(kw.synonyms ?? [])];
    for (const term of terms) {
      const tokens = await tokenize(term);
      const normalizedTerm = term.normalize("NFKC").toLowerCase().trim();
      const candidates = [...new Set([normalizedTerm, ...tokens])].filter(Boolean);
      const phraseWeight = tokens.length > 1 && tokens.some((token) => JAPANESE_CHAR.test(token))
        ? computeJapanesePhraseWeight(kw.weight, tokens.length)
        : kw.weight;
      for (const token of candidates) {
        const canonical = synonymMap.get(token) ?? token;
        const documentFrequency = corpus.termDocFreq.get(canonical) ?? 0;
        const rarityWeight = Math.log((corpus.docCount + 1) / (documentFrequency + 1)) + 1;
        weights.set(canonical, Math.max(weights.get(canonical) ?? 0, phraseWeight * rarityWeight));
      }
    }
  }
  return weights;
}

async function normalizeTokens(
  text: string,
  synonymMap: Map<string, string>
): Promise<string[]> {
  const tokens = await tokenize(text);
  return tokens.map((t) => synonymMap.get(t) ?? t);
}

async function buildQueryTokens(keywords: KeywordWeight[]): Promise<string[]> {
  const queryText = keywords.map((keyword) => keyword.term).join(" ");
  const tokens = await tokenize(queryText);
  const rawTerms = keywords
    .flatMap((keyword) => [keyword.term, ...(keyword.synonyms ?? [])])
    .map((term) => term.normalize("NFKC").toLowerCase().trim())
    .filter(Boolean);
  return [...new Set([...rawTerms, ...tokens])];
}

async function buildMorphologicalQueryTokens(keywords: KeywordWeight[]): Promise<string[]> {
  const rawTerms = keywords.flatMap((keyword) => [keyword.term, ...(keyword.synonyms ?? [])]).map((term) => term.normalize("NFKC").toLowerCase().trim()).filter(Boolean);
  return [...new Set([...rawTerms, ...(await tokenizeMorphological(keywords.map((keyword) => keyword.term).join(" ")))])];
}

function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Context Bonus: スライディングウィンドウ内で
 * 複数クエリ語が共起するほど bonus が maxBonus に近づく。
 */
function computeContextBonus(
  tokens: string[],
  queryTerms: string[],
  maxBonus: number,
  windowSize = 50
): number {
  const termSet = new Set(queryTerms);
  let maxCooccur = 0;
  for (let i = 0; i < tokens.length; i++) {
    const found = new Set(
      tokens.slice(i, i + windowSize).filter((t) => termSet.has(t))
    );
    maxCooccur = Math.max(maxCooccur, found.size);
  }
  const ratio = Math.min(maxCooccur / Math.max(queryTerms.length, 1), 1);
  return 1 + (maxBonus - 1) * ratio;
}

// ═══════════════════════════════════════════════════════════════════
//  § 4. BM25 エンジン
// ═══════════════════════════════════════════════════════════════════

/**
 * BM25 スコア式:
 *   Score = (Σ BM25_i × W_i) × Context_Bonus × e^(-λt)
 *
 *   BM25_i = IDF_i × [ f_i(k1+1) / (f_i + k1(1-b+b·|d|/avgdl)) ]
 *   IDF_i  = log((N - df_i + 0.5) / (df_i + 0.5) + 1)   ← Robertson 版
 */
class BM25Engine {
  private corpus: CorpusStats;

  private scoreSignal(tokens: string[], docLen: number, queryTerms: string[], stats: { avgDocLength: number; termDocFreq: Map<string, number> }, mode: ModeConfig, keywordWeights: Map<string, number>): number {
    const tf = computeTF(tokens);
    let total = 0;
    for (const canonical of new Set(queryTerms)) {
      const f = tf.get(canonical) ?? 0;
      if (f === 0) continue;
      const df = stats.termDocFreq.get(canonical) ?? 0;
      const idf = Math.log((this.corpus.docCount - df + 0.5) / (df + 0.5) + 1);
      const numerator = f * (mode.k1 + 1);
      const denominator = f + mode.k1 * (1 - mode.b + mode.b * (docLen / Math.max(stats.avgDocLength, 1)));
      total += idf * (numerator / denominator) * (keywordWeights.get(canonical) ?? 1);
    }
    return total;
  }

  constructor(corpus: CorpusStats) {
    this.corpus = corpus;
  }

  updateCorpus(stats: CorpusStats): void {
    this.corpus = stats;
  }

  private idf(term: string): number {
    const df = this.corpus.termDocFreq.get(term) ?? 0;
    const N = this.corpus.docCount;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  score(
    article: Article,
    mode: ModeConfig,
    synonymMap: Map<string, string>,
    keywordWeights: Map<string, number>,
    queryTokens: string[],
    keywordGroups: KeywordGroup[],
    timeDecayFloor: number,
    morphologicalQueryTokens: string[] = []
  ): ScoredArticle {
    // タイトルを 2 回結合して重みを 2 倍にする
    const tokens = (article.tokens ?? []).map(
      (token) => synonymMap.get(token) ?? token
    );
    const tf = computeTF(tokens);
    const docLen = article.docLength ?? tokens.length;

    const queryTerms = queryTokens.map(
      (token) => synonymMap.get(token) ?? token
    );

    const matchedTerms: MatchedTerm[] = [];
    let bm25Sum = 0;

    for (const queryTerm of new Set(queryTerms)) {
      const canonical = synonymMap.get(queryTerm) ?? queryTerm;
      const f = tf.get(canonical) ?? 0;
      if (f === 0) continue;

      const idfVal = this.idf(canonical);
      const numerator = f * (mode.k1 + 1);
      const denominator =
        f + mode.k1 * (1 - mode.b + mode.b * (docLen / this.corpus.avgDocLength));
      const bm25 = idfVal * (numerator / denominator);
      const weight = keywordWeights.get(canonical) ?? 1;
      const contribution = bm25 * weight;

      matchedTerms.push({
        term: queryTerm,
        tf: f,
        idf: idfVal,
        bm25,
        weight,
        contribution,
      });
      bm25Sum += contribution;
    }

    const ctx = computeContextBonus(
      tokens,
      queryTerms.filter((t) => (tf.get(t) ?? 0) > 0),
      mode.contextBonus
    );

    const matchedGroupCount = keywordGroups.filter((group) => group.length > 0 && group.every((term) => (tf.get(term) ?? 0) > 0)).length;
    const groupCoverage = keywordGroups.length > 0 ? matchedGroupCount / keywordGroups.length : 0;
    const groupBonus = 1 + 0.5 * groupCoverage;

    const elapsedDays = (Date.now() - article.publishedAt.getTime()) / 86_400_000;
    // Freshness must not erase a relevant older document; keep a small floor for local archives.
    const decay = Math.max(timeDecayFloor, Math.exp(-mode.lambda * elapsedDays));
    const morphologicalTokens = (article.morphologicalTokens ?? []).map((token) => synonymMap.get(token) ?? token);
    const morphologicalQuery = morphologicalQueryTokens.map((token) => synonymMap.get(token) ?? token);
    const bm25Morphological = this.corpus.morphologicalStats && morphologicalTokens.length
      ? this.scoreSignal(morphologicalTokens, article.morphologicalDocLength ?? morphologicalTokens.length, morphologicalQuery, this.corpus.morphologicalStats, mode, keywordWeights)
      : bm25Sum;
    const ngramWeight = mode.ngramWeight ?? 0.7;
    const morphologicalWeight = mode.morphologicalWeight ?? 0.3;
    const weightedBm25 = bm25Morphological * morphologicalWeight + bm25Sum * ngramWeight;
    const finalScore = weightedBm25 * ctx * groupBonus * decay;

    return {
      article,
      score: finalScore,
      breakdown: { bm25Raw: weightedBm25, bm25Morphological, bm25Ngram: bm25Sum, normalizedMorphological: 0, normalizedNgram: 0, tokenWeights: { morphological: morphologicalWeight, ngram: ngramWeight }, contextBonus: ctx * groupBonus, timeDecay: decay, finalScore, matchedTerms },
    };
  }

  scoreAll(
    articles: Article[],
    mode: ModeConfig,
    synonymMap: Map<string, string>,
    keywordWeights: Map<string, number>,
    queryTokens: string[],
    keywordGroups: KeywordGroup[],
    timeDecayFloor: number,
    morphologicalQueryTokens: string[] = []
  ): ScoredArticle[] {
    const scored = articles.map((a) => this.score(a, mode, synonymMap, keywordWeights, queryTokens, keywordGroups, timeDecayFloor, morphologicalQueryTokens));
    const maxMorphological = Math.max(...scored.map((item) => item.breakdown.bm25Morphological), 0);
    const maxNgram = Math.max(...scored.map((item) => item.breakdown.bm25Ngram), 0);
    const morphologicalWeight = mode.morphologicalWeight ?? 0.3;
    const ngramWeight = mode.ngramWeight ?? 0.7;
    for (const item of scored) {
      const normalizedMorphological = maxMorphological > 0 ? item.breakdown.bm25Morphological / maxMorphological : 0;
      const normalizedNgram = maxNgram > 0 ? item.breakdown.bm25Ngram / maxNgram : 0;
      const weightedBm25 = normalizedMorphological * morphologicalWeight + normalizedNgram * ngramWeight;
      const finalScore = weightedBm25 * item.breakdown.contextBonus * item.breakdown.timeDecay;
      item.breakdown.normalizedMorphological = normalizedMorphological;
      item.breakdown.normalizedNgram = normalizedNgram;
      item.breakdown.bm25Raw = weightedBm25;
      item.breakdown.finalScore = finalScore;
      item.score = finalScore;
    }
    return scored;
  }
}

async function buildCorpusStats(
  articles: Article[],
  mode: ModeConfig,
  synonymMap: Map<string, string>
): Promise<CorpusStats> {
  const termDocFreq = new Map<string, number>();
  const morphologicalTermDocFreq = new Map<string, number>();
  let totalLen = 0;
  let morphologicalTotalLen = 0;

  for (const article of articles) {
    const tokens = (article.tokens ?? []).map(
      (token) => synonymMap.get(token) ?? token
    );
    const morphologicalTokens = (article.morphologicalTokens ?? []).map((token) => synonymMap.get(token) ?? token);
    totalLen += article.docLength ?? tokens.length;
    morphologicalTotalLen += article.morphologicalDocLength ?? morphologicalTokens.length;
    const seen = new Set(tokens);
    for (const t of seen) termDocFreq.set(t, (termDocFreq.get(t) ?? 0) + 1);
    for (const t of new Set(morphologicalTokens)) morphologicalTermDocFreq.set(t, (morphologicalTermDocFreq.get(t) ?? 0) + 1);
  }

  return {
    docCount: articles.length,
    avgDocLength: articles.length > 0 ? totalLen / articles.length : 500,
    termDocFreq,
    morphologicalStats: { avgDocLength: articles.length > 0 ? morphologicalTotalLen / articles.length : 500, termDocFreq: morphologicalTermDocFreq },
  };
}

function resolveArticleTokens(articles: Article[]): {
  articles: Article[];
  fallbackCount: number;
} {
  const resolved: Article[] = [];

  for (const article of articles) {
    const ngramTokens = Array.isArray(article.ngramTokens) && article.ngramTokens.length
      ? article.ngramTokens
      : expandJapaneseTokens(Array.isArray(article.tokens) ? article.tokens : []);
    const morphologicalTokens = Array.isArray(article.morphologicalTokens) && article.morphologicalTokens.length
      ? article.morphologicalTokens
      : (Array.isArray(article.tokens) ? article.tokens : []);
    resolved.push({
      ...article,
      tokens: ngramTokens,
      ngramTokens,
      morphologicalTokens,
      docLength: article.ngramDocLength ?? ngramTokens.length,
      ngramDocLength: article.ngramDocLength ?? ngramTokens.length,
      morphologicalDocLength: article.morphologicalDocLength ?? morphologicalTokens.length,
    });
  }

  return { articles: resolved, fallbackCount: 0 };
}

// ═══════════════════════════════════════════════════════════════════
//  § 5. LSH 重複排除 & Priority スコア
// ═══════════════════════════════════════════════════════════════════

/**
 * k-shingle + Jaccard 類似度による重複検出。
 * 本番では minhash-lsh パッケージへの置き換えでスケールアップ可能。
 */
function shingleHash(text: string, k = 5): Set<number> {
  const hashes = new Set<number>();
  const lower = text.toLowerCase();
  for (let i = 0; i <= lower.length - k; i++) {
    let h = 2166136261;
    for (let j = 0; j < k; j++) {
      h ^= lower.charCodeAt(i + j);
      h = (h * 16777619) >>> 0;
    }
    hashes.add(h);
  }
  return hashes;
}

function jaccardSimilarity(a: Set<number>, b: Set<number>): number {
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

type DuplicatePair = readonly [number, number];

const LSH_PERMUTATIONS = 64;
const LSH_BANDS = 16;
const LSH_ROWS_PER_BAND = 4;

function mixHash(value: number, seed: number): number {
  let hash = (value ^ (seed * 0x9e3779b9)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function minHashSignature(shingles: Set<number>): number[] {
  if (shingles.size === 0) return new Array(LSH_PERMUTATIONS).fill(0xffffffff);
  return Array.from({ length: LSH_PERMUTATIONS }, (_, seed) => {
    let minimum = 0xffffffff;
    for (const shingle of shingles) minimum = Math.min(minimum, mixHash(shingle, seed + 1));
    return minimum;
  });
}

function lshCandidatePairs(hashes: Array<Set<number>>): DuplicatePair[] {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < hashes.length; index++) {
    const signature = minHashSignature(hashes[index]!);
    for (let band = 0; band < LSH_BANDS; band++) {
      const start = band * LSH_ROWS_PER_BAND;
      const key = `${band}:${signature.slice(start, start + LSH_ROWS_PER_BAND).join(",")}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(index);
      buckets.set(key, bucket);
    }
  }

  const pairs = new Set<string>();
  for (const bucket of buckets.values()) {
    for (let left = 0; left < bucket.length; left++) {
      for (let right = left + 1; right < bucket.length; right++) {
        const a = Math.min(bucket[left]!, bucket[right]!);
        const b = Math.max(bucket[left]!, bucket[right]!);
        pairs.add(`${a}:${b}`);
      }
    }
  }
  return [...pairs].map((pair) => pair.split(":").map(Number) as unknown as DuplicatePair);
}

function exactCandidatePairs(hashes: Array<Set<number>>): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  for (let left = 0; left < hashes.length; left++) {
    for (let right = left + 1; right < hashes.length; right++) pairs.push([left, right]);
  }
  return pairs;
}

function duplicatePairsForArticles(articles: Article[], threshold: number, useLsh: boolean): DuplicatePair[] {
  const hashes = articles.map((article) => shingleHash(`${article.title} ${article.body.slice(0, 500)}`));
  const candidates = useLsh ? lshCandidatePairs(hashes) : exactCandidatePairs(hashes);
  return candidates.filter(([left, right]) => jaccardSimilarity(hashes[left]!, hashes[right]!) >= threshold);
}

export function duplicatePairRecall(articles: Article[], threshold = 0.8): number {
  const exact = new Set(duplicatePairsForArticles(articles, threshold, false).map(([left, right]) => `${left}:${right}`));
  if (exact.size === 0) return 1;
  const detected = new Set(duplicatePairsForArticles(articles, threshold, true).map(([left, right]) => `${left}:${right}`));
  return [...exact].filter((pair) => detected.has(pair)).length / exact.size;
}

export function deduplicateArticles(articles: Article[], threshold = 0.8): Article[] {
  if (threshold >= 1) return articles;
  const hashes = articles.map((article) => shingleHash(`${article.title} ${article.body.slice(0, 500)}`));
  const keep = new Array<boolean>(articles.length).fill(true);
  const pairs = lshCandidatePairs(hashes).filter(([left, right]) => jaccardSimilarity(hashes[left]!, hashes[right]!) >= threshold);
  for (const [left, right] of pairs) {
    if (!keep[left] || !keep[right]) continue;
    const leftQuality = articles[left]!.body.length * articles[left]!.sourceAuthority;
    const rightQuality = articles[right]!.body.length * articles[right]!.sourceAuthority;
    keep[leftQuality >= rightQuality ? right : left] = false;
  }
  return articles.filter((_, i) => keep[i]);
}

/**
 * Priority = Quality × Freshness × Authority
 * グループ内代表記事の選出に使う。
 */
// ═══════════════════════════════════════════════════════════════════
//  § 6. 自動アーカイブ判定
// ═══════════════════════════════════════════════════════════════════

function evaluateArchive(scored: ScoredArticle, scoreThreshold = 0.5): ArchiveDecision {
  if (scored.score < scoreThreshold) {
    return {
      shouldArchive: true,
      reason: `スコア閾値割れ (${scored.score.toFixed(3)} < ${scoreThreshold})`,
    };
  }
  return { shouldArchive: false, reason: "" };
}

// ═══════════════════════════════════════════════════════════════════
//  § 7. メインパイプライン
//       Layer1 重複排除 → Layer2 BM25スコアリング → Layer3 自動アーカイブ
// ═══════════════════════════════════════════════════════════════════

export async function runPipeline(
  rawArticles: Article[],
  mode: ModeConfig,
  modeId: string,
  options: {
    dedupThreshold?: number;
    archiveScoreThreshold?: number;
    resultLimit?: number;
    timeDecayFloor?: number;
  } = {}
): Promise<PipelineResult> {
  const totalStart = nowMs();
  const timings: BenchmarkTimings = {
    tokenPreparationMs: 0,
    scoringMs: 0,
    sortingLimitMs: 0,
    totalSearchMs: 0,
  };
  const {
    dedupThreshold = 0.8,
    archiveScoreThreshold = 0.5,
    resultLimit = 50,
    timeDecayFloor = 0.35,
  } = options;

  // Layer 1: LSH 重複排除
  const deduped = deduplicateArticles(rawArticles, dedupThreshold);

  // Layer 2: コーパス統計構築 → BM25 スコアリング
  const queryTokens = await buildQueryTokens(mode.keywords);
  if (queryTokens.length === 0) {
    return {
      active: [],
      belowThreshold: [],
      archived: [],
      stats: {
        inputCount: rawArticles.length,
        afterDedup: deduped.length,
        activeCount: 0,
        archivedCount: 0,
        modeUsed: modeId,
        avgScore: 0,
        timings: { ...timings, totalSearchMs: Number((nowMs() - totalStart).toFixed(3)) },
      },
    };
  }
  const prepStart = nowMs();
  const resolved = resolveArticleTokens(deduped);
  const morphologicalQueryTokens = await buildMorphologicalQueryTokens(mode.keywords);
  const synonymMap = await buildSynonymMap(mode.keywords);
  const keywordGroups = await Promise.all(mode.keywords.map(async (keyword) => {
    const tokens = await tokenize(keyword.term);
    return [...new Set(tokens.map((token) => synonymMap.get(token) ?? token))];
  }));
  const corpus = await buildCorpusStats(resolved.articles, mode, synonymMap);
  const keywordWeights = await buildKeywordWeightMap(mode.keywords, synonymMap, corpus);
  timings.tokenPreparationMs = Number((nowMs() - prepStart).toFixed(3));
  const engine = new BM25Engine(corpus);
  const scoreStart = nowMs();
  const scored = engine.scoreAll(
    resolved.articles,
    mode,
    synonymMap,
    keywordWeights,
    queryTokens,
    keywordGroups,
    timeDecayFloor,
    morphologicalQueryTokens
  ).filter((item) => item.score > 0);
  timings.scoringMs = Number((nowMs() - scoreStart).toFixed(3));

  // Layer 3: 自動アーカイブ判定
  const active: ScoredArticle[] = [];
  const archived: Array<{ article: Article; reason: string }> = [];
  const sortStart = nowMs();
  scored.sort((a, b) => b.score - a.score);

  for (const s of scored) {
    const decision = evaluateArchive(s, archiveScoreThreshold);
    if (decision.shouldArchive) {
      archived.push({ article: s.article, reason: decision.reason });
    } else {
      active.push(s);
    }
  }

  const safeResultLimit = Math.min(Math.max(Math.floor(resultLimit), 1), 500);
  const limitedActive = active.slice(0, safeResultLimit);
  const limitedArchived = archived.slice(0, Math.max(0, safeResultLimit - limitedActive.length));
  timings.sortingLimitMs = Number((nowMs() - sortStart).toFixed(3));

  const avgScore =
    limitedActive.length > 0
      ? limitedActive.reduce((sum, s) => sum + s.score, 0) / limitedActive.length
      : 0;

  return {
    active: limitedActive,
    belowThreshold: limitedArchived,
    archived: limitedArchived,
    stats: {
      inputCount: rawArticles.length,
      afterDedup: deduped.length,
      activeCount: active.length,
      archivedCount: archived.length,
      modeUsed: modeId,
      avgScore,
      timings: { ...timings, totalSearchMs: Number((nowMs() - totalStart).toFixed(3)) },
    },
  };
}
