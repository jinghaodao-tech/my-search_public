import fs from 'node:fs';
import path from 'node:path';
import kuromoji from 'kuromoji';

const [databaseArg, evaluationArg, outputArg] = process.argv.slice(2);
if (!databaseArg || !evaluationArg) throw new Error('Usage: analyze_miracl_recall_clues.ts <isolated.sqlite> <evaluation.json> [output.json]');
process.env.DB_PATH = path.resolve(databaseArg);
process.env.NODE_ENV = 'test';
process.env.SITE_SYNC = 'off';
delete process.env.API_KEY;

interface EvalRow { qid: string; groupId: string; query: string; parsedTerms: string[]; gold_ids: string[]; hit10: boolean; hit1000: boolean }
interface SummaryRow {
  qid: string; groupId: string; query: string; goldCount: number; parsedTermCount: number;
  matchedTitleTerms: string[]; matchedBodyTerms: string[]; properNouns: string[];
  matchedProperNounsTitle: string[]; matchedProperNounsBody: string[];
  titleOverlap: boolean; properNounOverlap: boolean;
  clueClass: 'title-overlap' | 'body-only-overlap' | 'no-parsed-term-overlap';
  hit10: boolean; hit1000: boolean;
}
const evaluation = JSON.parse(fs.readFileSync(path.resolve(evaluationArg), 'utf8')) as { queryCount: number; results: EvalRow[] };
const [{ db }] = await Promise.all([import('../../db/database.js')]);
const tokenizer = await new Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>>((resolve, reject) => {
  kuromoji.builder({ dicPath: path.join(process.cwd(), 'node_modules/kuromoji/dict/') })
    .build((error, instance) => error ? reject(error) : resolve(instance));
});
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja-JP');
const summaryRows: SummaryRow[] = [];
const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(',');

try {
  for (const row of evaluation.results) {
    const ids = row.gold_ids.map(id => `miracl-ja-${id}`);
    const docs = ids.length
      ? db.prepare(`SELECT id, title, body FROM articles WHERE id IN (${placeholders(ids.length)})`).all(...ids) as Array<{ id: string; title: string; body: string }>
      : [];
    const titleText = docs.map(doc => normalize(doc.title ?? ''));
    const bodyText = docs.map(doc => normalize(doc.body ?? ''));
    const terms = [...new Set(row.parsedTerms.map(normalize).filter(Boolean))];
    const properNouns = [...new Set(tokenizer.tokenize(normalize(row.query))
      .filter(token => token.pos === '名詞' && token.pos_detail_1 === '固有名詞')
      .map(token => normalize(token.basic_form && token.basic_form !== '*' ? token.basic_form : token.surface_form))
      .filter(term => term.length > 1))];
    const matchedTitleTerms = terms.filter(term => titleText.some(text => text.includes(term)));
    const matchedBodyTerms = terms.filter(term => bodyText.some(text => text.includes(term)));
    const matchedProperNounsTitle = properNouns.filter(term => titleText.some(text => text.includes(term)));
    const matchedProperNounsBody = properNouns.filter(term => bodyText.some(text => text.includes(term)));
    summaryRows.push({
      qid: row.qid, groupId: row.groupId, query: row.query, goldCount: row.gold_ids.length,
      parsedTermCount: terms.length, matchedTitleTerms, matchedBodyTerms,
      properNouns, matchedProperNounsTitle, matchedProperNounsBody,
      titleOverlap: matchedTitleTerms.length > 0,
      properNounOverlap: matchedProperNounsTitle.length + matchedProperNounsBody.length > 0,
      clueClass: matchedTitleTerms.length ? 'title-overlap' : matchedBodyTerms.length ? 'body-only-overlap' : 'no-parsed-term-overlap',
      hit10: row.hit10, hit1000: row.hit1000,
    });
  }
  const summarize = (rows: SummaryRow[]) => ({
    queryCount: rows.length,
    titleOverlapQueries: rows.filter(row => row.titleOverlap).length,
    properNounQueries: rows.filter(row => row.properNouns.length > 0).length,
    properNounOverlapQueries: rows.filter(row => row.properNounOverlap).length,
    hit10: rows.filter(row => row.hit10).length,
    hit10Rate: rows.length ? rows.filter(row => row.hit10).length / rows.length : 0,
  });
  const result = {
    dataset: 'MIRACL Japanese validation; lexical overlap proxies only, not observed user memory',
    corpusTagsAvailable: false,
    tokenizer: 'Kuromoji from the application dependency; query POS fine class 固有名詞; NFKC + ja-JP lowercase for overlap',
    queryCount: evaluation.queryCount,
    byClueClass: Object.fromEntries(['title-overlap', 'body-only-overlap', 'no-parsed-term-overlap'].map(key => [key, summarize(summaryRows.filter(row => row.clueClass === key))])),
    properNounMention: summarize(summaryRows.filter(row => row.properNouns.length > 0)),
    all: summarize(summaryRows),
    limitations: ['MIRACL qrels do not say what a searcher remembered.', 'Title/body overlap is an observable lexical proxy, not an actual memory condition.', 'The imported MIRACL corpus has no user tags; tag recall cannot be measured.'],
    results: summaryRows,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputArg) fs.writeFileSync(path.resolve(outputArg), serialized, 'utf8');
  console.log(JSON.stringify({ ...result, results: undefined }, null, 2));
} finally {
  db.close();
}
