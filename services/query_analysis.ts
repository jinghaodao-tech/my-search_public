/**
 * Looking at a search text before searching: which words carry the topic, which are generic
 * ("問題", "最近", "勉強"), what kind of question it is, and whether it is too broad for keyword search.
 * Rules only (no AI); the browser's on-device AI can then split a broad question into topics.
 */

export type QueryIntent = 'trend' | 'learn' | 'overview' | 'howto' | 'why' | 'compare' | 'case' | 'future' | 'mine';

export const INTENT_LABELS: Record<QueryIntent, string> = {
  trend: '今の傾向',
  learn: '学ぶべきこと',
  overview: '全体像',
  howto: 'やり方',
  why: '理由・原因',
  compare: '比較',
  case: '事例',
  future: '今後の予想',
  mine: '自分のメモ',
};

// Order matters: the first match is the intent.
const INTENT_PATTERNS: Array<[QueryIntent, RegExp]> = [
  ['mine', /(前に読んだ|メモした|保存した|自分のメモ|自分のカード)/],
  ['compare', /(\svs\.?\s|比較|違い|どっち|どちら)/i],
  ['future', /(今後|将来|これから|展望|予測|未来)/],
  ['trend', /(最近|いま|現在|今の|今話題|トレンド|話題|流行|注目|問題になって)/],
  ['learn', /(勉強|学ぶ|学習|入門|ロードマップ|身につけ|おすすめ|すべき)/],
  ['why', /(なぜ|原因|理由|背景)/],
  ['howto', /(方法|やり方|どうやって|手順|仕方|するには)/],
  ['case', /(事例|導入例|他社|実例|活用例|どうしてる)/],
  ['overview', /(とは|全体像|概要|まとめ|基本)/],
];

/** Words that appear in almost any article: they cannot say which article is meant. */
export const GENERIC_TERMS = new Set([
  '問題', '課題', '現在', '現代', '最近', '今後', '将来', '業界', '世界', '社会', '時代', '話題', '傾向', 'トレンド', '状況',
  '勉強', '学習', '入門', '基礎', '基本', '知識', 'スキル', 'おすすめ', '注目', '重要', '大切', '全体', '全体像', '概要', 'まとめ',
  '方法', '手順', '事例', '比較', '違い', '原因', '理由', '背景', '情報', '内容', '記事', '仕事', '人', '今', '話',
]);

/** Common English function words add matches but little topic evidence in saved-article search. */
const ENGLISH_STOP = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself nor of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours`.split(' '));

export type QueryAnalysis = {
  keywords: Array<{ term: string; weight: number }>;
  intent: QueryIntent | null;
  intentLabel: string | null;
  /** generic words that were kept with a low weight */
  genericTerms: string[];
  /** words that say which article is meant */
  specificTerms: string[];
  broad: boolean;
  reason: string | null;
};

const KATAKANA = /^[\u30a0-\u30ffー]+$/u;
/** ページ + ラッチ written together as ページラッチ is one word for the reader: search it as one. */
function mergeKatakana(text: string, words: string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    const previous = out[out.length - 1];
    if (previous && KATAKANA.test(previous) && KATAKANA.test(word) && text.includes(previous + word)) out[out.length - 1] = previous + word;
    else out.push(word);
  }
  return out;
}

export function detectIntent(text: string): QueryIntent | null {
  for (const [intent, pattern] of INTENT_PATTERNS) if (pattern.test(` ${text} `)) return intent;
  return null;
}

/** words: the content words of the text, in order (from purposeWords). */
export function analyzeQuery(text: string, words: string[], baseWeight: (term: string) => number = () => 1): QueryAnalysis {
  const intent = detectIntent(text);
  const genericTerms: string[] = [];
  const specificTerms: string[] = [];
  const keywords: Array<{ term: string; weight: number }> = [];
  for (const term of mergeKatakana(text, words)) {
    const lower = term.toLowerCase();
    if (ENGLISH_STOP.has(lower)) {
      // Keep explicit acronyms and the Go language, but not sentence-initial "What" or "The".
      const written = text.match(new RegExp(`(?<![A-Za-z])${lower}(?![A-Za-z])`, 'i'))?.[0] ?? '';
      const intentionalName = (written.length <= 3 && written === written.toUpperCase()) || (lower === 'go' && written === 'Go');
      if (intentionalName) { keywords.push({ term, weight: 0.5 }); specificTerms.push(term); }
      continue;
    }
    if (GENERIC_TERMS.has(term)) { keywords.push({ term, weight: 0.4 }); genericTerms.push(term); continue; }
    keywords.push({ term, weight: baseWeight(term) });
    specificTerms.push(term);
  }
  const shown = (term: string) => text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))?.[0] ?? term;
  let reason: string | null = null;
  if (specificTerms.length === 0) reason = '特定のテーマを指す言葉がありません';
  else if (intent && intent !== 'mine' && specificTerms.length <= 1 && genericTerms.length >= 1) reason = `テーマを指す言葉が「${shown(specificTerms[0])}」だけです`;
  else if (specificTerms.length <= 1 && genericTerms.length >= 2) reason = `テーマを指す言葉が「${shown(specificTerms[0])}」だけです`;
  return {
    keywords: keywords.length ? keywords : words.map(term => ({ term, weight: 1 })),
    intent,
    intentLabel: intent ? INTENT_LABELS[intent] : null,
    genericTerms,
    specificTerms,
    broad: reason !== null,
    reason,
  };
}
