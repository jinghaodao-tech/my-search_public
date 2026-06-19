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

interface ModeConfig {
  label: string;
  description: string;
  k1: number;            // BM25 飽和速度 (推奨: 0.5–3.0)
  b: number;             // BM25 文書長補正 (推奨: 0–1)
  lambda: number;        // 時間減衰 λ (大きいほど古い記事が急落)
  contextBonus: number;  // Context bonus 上限 (キーワード共起ボーナス)
  keywords: KeywordWeight[];
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
}

interface ScoredArticle {
  article: Article;
  score: number;
  breakdown: ScoreBreakdown;
}

interface ScoreBreakdown {
  bm25Raw: number;
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
  avgDocLength: number;
  termDocFreq: Map<string, number>; // term → 出現文書数
}

interface PipelineResult {
  active: ScoredArticle[];
  archived: Array<{ article: Article; reason: string }>;
  stats: {
    inputCount: number;
    afterDedup: number;
    activeCount: number;
    archivedCount: number;
    modeUsed: string;
    avgScore: number;
  };
}

interface ArchiveDecision {
  shouldArchive: boolean;
  reason: string;
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
let _tokenizer: KuromojiTokenizer | null = null;

const DICT_PATH = path.join(__dirname, "node_modules/kuromoji/dict/");

async function getTokenizer(): Promise<KuromojiTokenizer> {
  if (_tokenizer) return _tokenizer;
  return new Promise((resolve, reject) => {
    kuromoji
      .builder({ dicPath: DICT_PATH })
      .build((err: Error | null, tokenizer: KuromojiTokenizer) => {
        if (err) return reject(err);
        _tokenizer = tokenizer;
        resolve(tokenizer);
      });
  });
}

/**
 * テキストを形態素解析してトークン列を返す。
 * - 名詞・動詞・形容詞のみ抽出（助詞・助動詞を除去）
 * - base_form（基本形）に正規化することで活用ゆれを吸収
 * - NFKC 正規化で全角→半角統一
 */
async function tokenize(text: string): Promise<string[]> {
  const tokenizer = await getTokenizer();
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = tokenizer.tokenize(normalized);

  return tokens
    .filter((t) => KEEP_POS.has(t.pos))
    .map((t) => (t.base_form ?? t.surface_form).toLowerCase())
    .filter((t) => t.length > 1);
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

async function normalizeTokens(
  text: string,
  synonymMap: Map<string, string>
): Promise<string[]> {
  const tokens = await tokenize(text);
  return tokens.map((t) => synonymMap.get(t) ?? t);
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

  async score(article: Article, mode: ModeConfig): Promise<ScoredArticle> {
    const synonymMap = await buildSynonymMap(mode.keywords);

    // タイトルを 2 回結合して重みを 2 倍にする
    const text = `${article.title} ${article.title} ${article.body}`;
    const tokens = await normalizeTokens(text, synonymMap);
    const tf = computeTF(tokens);
    const docLen = tokens.length;

    const queryTerms = mode.keywords.map(
      (kw) => synonymMap.get(kw.term.toLowerCase()) ?? kw.term.toLowerCase()
    );

    const matchedTerms: MatchedTerm[] = [];
    let bm25Sum = 0;

    for (const kw of mode.keywords) {
      const canonical =
        synonymMap.get(kw.term.toLowerCase()) ?? kw.term.toLowerCase();
      const f = tf.get(canonical) ?? 0;
      if (f === 0) continue;

      const idfVal = this.idf(canonical);
      const numerator = f * (mode.k1 + 1);
      const denominator =
        f + mode.k1 * (1 - mode.b + mode.b * (docLen / this.corpus.avgDocLength));
      const bm25 = idfVal * (numerator / denominator);
      const contribution = bm25 * kw.weight;

      matchedTerms.push({ term: kw.term, tf: f, idf: idfVal, bm25, weight: kw.weight, contribution });
      bm25Sum += contribution;
    }

    const ctx = computeContextBonus(
      tokens,
      queryTerms.filter((t) => (tf.get(t) ?? 0) > 0),
      mode.contextBonus
    );

    const elapsedDays = (Date.now() - article.publishedAt.getTime()) / 86_400_000;
    const decay = Math.exp(-mode.lambda * elapsedDays);
    const finalScore = bm25Sum * ctx * decay;

    return {
      article,
      score: finalScore,
      breakdown: { bm25Raw: bm25Sum, contextBonus: ctx, timeDecay: decay, finalScore, matchedTerms },
    };
  }

  async rank(articles: Article[], mode: ModeConfig): Promise<ScoredArticle[]> {
    const scored = await Promise.all(articles.map((a) => this.score(a, mode)));
    return scored.sort((a, b) => b.score - a.score);
  }
}

async function buildCorpusStats(
  articles: Article[],
  mode: ModeConfig
): Promise<CorpusStats> {
  const synonymMap = await buildSynonymMap(mode.keywords);
  const termDocFreq = new Map<string, number>();
  let totalLen = 0;

  for (const article of articles) {
    const tokens = await normalizeTokens(
      `${article.title} ${article.body}`,
      synonymMap
    );
    totalLen += tokens.length;
    const seen = new Set(tokens);
    for (const t of seen) termDocFreq.set(t, (termDocFreq.get(t) ?? 0) + 1);
  }

  return {
    docCount: articles.length,
    avgDocLength: articles.length > 0 ? totalLen / articles.length : 500,
    termDocFreq,
  };
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
  return intersection / (a.size + b.size - intersection);
}

function deduplicateArticles(articles: Article[], threshold = 0.8): Article[] {
  const hashes = articles.map((a) =>
    shingleHash(`${a.title} ${a.body.slice(0, 500)}`)
  );
  const keep = new Array<boolean>(articles.length).fill(true);

  for (let i = 0; i < articles.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < articles.length; j++) {
      if (!keep[j]) continue;
      if (jaccardSimilarity(hashes[i]!, hashes[j]!) >= threshold) {
        const si = articles[i]!.body.length * articles[i]!.sourceAuthority;
        const sj = articles[j]!.body.length * articles[j]!.sourceAuthority;
        keep[si >= sj ? j : i] = false;
      }
    }
  }
  return articles.filter((_, i) => keep[i]);
}

/**
 * Priority = Quality × Freshness × Authority
 * グループ内代表記事の選出に使う。
 */
function priorityScore(article: Article, bm25Score: number): number {
  const quality = Math.min(article.body.length / 2000, 1);
  const ageDays = (Date.now() - article.publishedAt.getTime()) / 86_400_000;
  const freshness = Math.exp(-0.05 * ageDays);
  return bm25Score * quality * freshness * article.sourceAuthority;
}

// ═══════════════════════════════════════════════════════════════════
//  § 6. 自動アーカイブ判定
// ═══════════════════════════════════════════════════════════════════

function evaluateArchive(
  scored: ScoredArticle,
  viewCount: number,
  scoreThreshold = 0.5,
  noViewDays = 14
): ArchiveDecision {
  const ageDays =
    (Date.now() - scored.article.publishedAt.getTime()) / 86_400_000;

  if (viewCount === 0 && ageDays >= noViewDays) {
    return { shouldArchive: true, reason: `未閲覧 ${noViewDays} 日経過` };
  }
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
    noViewDays?: number;
    viewCounts?: Map<string, number>;
  } = {}
): Promise<PipelineResult> {
  const {
    dedupThreshold = 0.8,
    archiveScoreThreshold = 0.5,
    noViewDays = 14,
    viewCounts = new Map(),
  } = options;

  // Layer 1: LSH 重複排除
  const deduped = deduplicateArticles(rawArticles, dedupThreshold);

  // Layer 2: コーパス統計構築 → BM25 スコアリング
  const corpus = await buildCorpusStats(deduped, mode);
  const engine = new BM25Engine(corpus);
  const scored = await engine.rank(deduped, mode);

  // Layer 3: 自動アーカイブ判定
  const active: ScoredArticle[] = [];
  const archived: Array<{ article: Article; reason: string }> = [];

  for (const s of scored) {
    const views = viewCounts.get(s.article.id) ?? 0;
    const decision = evaluateArchive(s, views, archiveScoreThreshold, noViewDays);
    if (decision.shouldArchive) {
      archived.push({ article: s.article, reason: decision.reason });
    } else {
      active.push(s);
    }
  }

  const avgScore =
    active.length > 0
      ? active.reduce((sum, s) => sum + s.score, 0) / active.length
      : 0;

  return {
    active,
    archived,
    stats: {
      inputCount: rawArticles.length,
      afterDedup: deduped.length,
      activeCount: active.length,
      archivedCount: archived.length,
      modeUsed: modeId,
      avgScore,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
//  § 8. デモ実行
// ═══════════════════════════════════════════════════════════════════

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

const SAMPLE_ARTICLES: Article[] = [
  {
    id: "a1",
    title: "React 19 の新機能と実装例",
    body: "React 19 がリリースされた。新しいコンパイラの実装により、パフォーマンスが大幅に向上した。GitHub で公開されているサンプルコードを参考に、実際のプロジェクトへの組み込み方を解説する。バグ修正も多数含まれる。",
    publishedAt: days(2),
    sourceAuthority: 0.9,
    url: "https://example.com/react19",
  },
  {
    id: "a2",
    title: "Transformer の注意機構の数学的証明",
    body: "Scaled Dot-Product Attention の定理と証明を示す。arxiv の論文に基づき、補題から始めて命題を導出する。引用文献は参考文献リストを参照。数式の展開においては行列演算の性質を利用する。",
    publishedAt: days(30),
    sourceAuthority: 0.95,
    url: "https://example.com/transformer-proof",
  },
  {
    id: "a3",
    title: "OpenAI が新プロダクトをリリース・資金調達も発表",
    body: "OpenAI は本日、新しいサービスの発表を行った。市場への影響は大きく、業界全体が注目している。資金調達ラウンドも同時に公開され、プロダクトの将来性を示した。",
    publishedAt: days(1),
    sourceAuthority: 0.8,
    url: "https://example.com/openai-news",
  },
  {
    id: "a4",
    title: "npm パッケージの脆弱性とエラー対応",
    body: "人気の npm パッケージにバグが発見された。エラーが発生する条件と修正方法を解説する。ライブラリのバージョンを固定するか、パッチを適用することで対応できる。GitHub の issue にも詳細が記載されている。",
    publishedAt: days(5),
    sourceAuthority: 0.75,
    url: "https://example.com/npm-bug",
  },
  {
    id: "a5",
    title: "React 19 安定版リリースのお知らせ（重複記事）",
    body: "React 19 がリリースされた。新しいコンパイラの実装により、パフォーマンスが大幅に向上した。GitHub のサンプルを参考に実装できる。バグ修正も多数含まれる最新バージョンだ。",
    publishedAt: days(2),
    sourceAuthority: 0.6,
    url: "https://example.com/react19-dup",
  },
  {
    id: "a6",
    title: "古い記事：2年前の JavaScript Tips",
    body: "JavaScript のちょっとしたコツを紹介する記事。実装時に役立つかもしれない。",
    publishedAt: days(730),
    sourceAuthority: 0.5,
    url: "https://example.com/old-js",
  },
];

async function main(): Promise<void> {
  console.log("kuromoji 辞書を読み込み中...");
  await getTokenizer(); // 事前ウォームアップ
  console.log("完了\n");

  for (const [modeId, mode] of Object.entries(MODES)) {
    console.log("═".repeat(62));
    console.log(`  モード: ${mode.label}  (${modeId})`);
    console.log(`  ${mode.description}`);
    console.log("═".repeat(62));

    const result = await runPipeline(SAMPLE_ARTICLES, mode, modeId, {
      archiveScoreThreshold: 0.3,
    });

    const s = result.stats;
    console.log(`\n  📊  入力 ${s.inputCount} → 重複排除後 ${s.afterDedup} → アクティブ ${s.activeCount} / アーカイブ ${s.archivedCount}  平均スコア: ${s.avgScore.toFixed(3)}\n`);

    if (result.active.length > 0) {
      console.log("  🏆 アクティブ（スコア順）");
      for (const a of result.active) {
        const top = a.breakdown.matchedTerms
          .sort((x, y) => y.contribution - x.contribution)
          .slice(0, 3)
          .map((m) => `${m.term}(${m.contribution.toFixed(2)})`)
          .join(", ");
        console.log(`    [${a.score.toFixed(3)}] ${a.article.title}`);
        console.log(`           BM25=${a.breakdown.bm25Raw.toFixed(3)}  ctx=${a.breakdown.contextBonus.toFixed(2)}  decay=${a.breakdown.timeDecay.toFixed(3)}  → ${top || "—"}`);
      }
    }

    if (result.archived.length > 0) {
      console.log("\n  📦 アーカイブ");
      for (const a of result.archived) {
        console.log(`    - ${a.article.title}`);
        console.log(`      理由: ${a.reason}`);
      }
    }

    console.log();
  }
}

// スタンドアロン実行時のみ main() を呼ぶ
const isMain = process.argv[1] &&
  (import.meta.url === 'file://' + process.argv[1].replace(/\\/g, '/') ||
   import.meta.url.endsWith(process.argv[1]));
if (isMain) { main().catch(console.error); }
