import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

type QueryRow = {
  group_id: string;
  query: string;
  parserTerms: string[];
  gold_ids: string[];
  standard: { hit10: number; mrr10: number; ndcg10: number };
  currentFts: { hit10: number; mrr10: number; ndcg10: number };
  titleVariants: Record<string, { hit10: number; mrr10: number; ndcg10: number }>;
  currentFtsTop10: string[];
  titleTop10: Record<string, string[]>;
};
type Input = { audit: string; dataset: { split: string; sourceSha256: string }; perQuery: QueryRow[] };
type CardTitle = { id: string; title: string };

const [databaseArg, outputArg, ...inputArgs] = process.argv.slice(2);
if (!databaseArg || !outputArg || inputArgs.length < 2) {
  throw new Error('Usage: analyze_tomt_rrf_failures.ts <isolated.db> <output.json> <title-rrf-sample.json> <title-rrf-sample.json> [...samples]');
}
const databasePath = path.resolve(databaseArg);
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite ${outputPath}`);
const reports = inputArgs.map(file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Input);
if (reports.some(report => report.dataset.split !== 'development' || report.dataset.sourceSha256 !== reports[0]!.dataset.sourceSha256)) {
  throw new Error('Inputs must use the same Movies development corpus fingerprint');
}
const rows = reports.flatMap(report => report.perQuery);
if (new Set(rows.map(row => row.group_id)).size !== rows.length) throw new Error('Sample files overlap in target groups');
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const titles = new Map((db.prepare('SELECT id, title FROM cards WHERE archived=0').all() as CardTitle[])
  .map(row => [row.id.replace(/^benchmark-/, ''), row.title]));
const ftsTitleMatchesGold = new Set<string>();
const ftsTitleCandidateCounts = new Map<string, number>();
const countTitleMatches = db.prepare('SELECT COUNT(*) AS count FROM cards_fts WHERE cards_fts MATCH ?');
for (const row of rows) {
  const terms = [...new Set(row.parserTerms.map(term => term.trim()).filter(Boolean))];
  if (!terms.length) continue;
  const expression = `title : (${terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')})`;
  const candidateCount = (countTitleMatches.get(expression) as { count: number }).count;
  ftsTitleCandidateCounts.set(row.group_id, candidateCount);
  const ids = row.gold_ids;
  const placeholders = ids.map(() => '?').join(',');
  const matches = db.prepare(`SELECT id FROM cards_fts WHERE cards_fts MATCH ? AND id IN (${placeholders})`).all(expression, ...ids) as Array<{ id: string }>;
  if (matches.length) ftsTitleMatchesGold.add(row.group_id);
}
db.close();

const normalized = (value: string) => value.normalize('NFKC').toLowerCase();
const exactTitleTerms = (row: QueryRow) => {
  const title = normalized(row.gold_ids.map(id => titles.get(id) ?? '').join(' '));
  return row.parserTerms.filter(term => {
    const normalizedTerm = normalized(term).trim();
    return normalizedTerm.length >= 2 && title.includes(normalizedTerm);
  });
};
const categories = new Map<string, QueryRow[]>();
for (const row of rows) {
  const category = ftsTitleMatchesGold.has(row.group_id) ? 'fts_title_query_matches_gold_document' : 'fts_title_query_does_not_match_gold_document';
  categories.set(category, [...(categories.get(category) ?? []), row]);
}
const summarize = (values: QueryRow[]) => {
  const count = (method: 'standard' | 'currentFts' | 'title') => values.reduce((sum, row) =>
    sum + (method === 'title' ? row.titleVariants['0.1']!.hit10 : row[method].hit10), 0);
  const standard = count('standard');
  const currentFts = count('currentFts');
  const title = count('title');
  const titleWins = values.filter(row => row.titleVariants['0.1']!.hit10 && !row.standard.hit10).length;
  const titleLosses = values.filter(row => !row.titleVariants['0.1']!.hit10 && row.standard.hit10).length;
  return {
    groups: values.length,
    parserTermCountMean: Number((values.reduce((sum, row) => sum + row.parserTerms.length, 0) / Math.max(values.length, 1)).toFixed(2)),
    hitAt10: { standard, currentFtsRrf: currentFts, titleRrf01: title },
    differencesVsStandard: { currentFtsRrf: currentFts - standard, titleRrf01: title - standard },
    titleRrf01PairedTransitionsVsStandard: { candidateOnly: titleWins, baselineOnly: titleLosses },
    meanMrrAt10: {
      standard: Number((values.reduce((sum, row) => sum + row.standard.mrr10, 0) / Math.max(values.length, 1)).toFixed(4)),
      titleRrf01: Number((values.reduce((sum, row) => sum + row.titleVariants['0.1']!.mrr10, 0) / Math.max(values.length, 1)).toFixed(4)),
    },
  };
};
const thresholdSweep = [0, 5, 10, 20, 50, 100, 250, 500, 1000, Number.POSITIVE_INFINITY].map(maxTitleCandidates => {
  const rowsForThreshold = rows.map(row => {
    const useTitle = (ftsTitleCandidateCounts.get(row.group_id) ?? Number.POSITIVE_INFINITY) <= maxTitleCandidates;
    const candidateHit = useTitle ? row.titleVariants['0.1']!.hit10 : row.currentFts.hit10;
    return { standard: row.standard.hit10, candidateHit };
  });
  const standard = rowsForThreshold.reduce((sum, row) => sum + row.standard, 0);
  const candidate = rowsForThreshold.reduce((sum, row) => sum + row.candidateHit, 0);
  return { maxTitleCandidates: Number.isFinite(maxTitleCandidates) ? maxTitleCandidates : 'all', groups: rows.length,
    hitAt10: candidate, standardHitAt10: standard, difference: candidate - standard,
    titleSignalUsedForGroups: rows.filter(row => (ftsTitleCandidateCounts.get(row.group_id) ?? Number.POSITIVE_INFINITY) <= maxTitleCandidates).length };
});
const result = {
  purpose: 'Exploratory failure analysis on already-consumed Movies development samples; no parameter selection or confirmatory claim.',
  inputs: inputArgs.map(file => path.resolve(file)),
  corpusDocumentCount: titles.size,
  uniqueTargetGroups: new Set(rows.map(row => row.group_id)).size,
  overall: summarize(rows),
  byFtsTitleMatch: Object.fromEntries([...categories].map(([name, values]) => [name, summarize(values)])),
  titleCandidateCountThresholdSweep: thresholdSweep,
  examples: {
    titleRrfOnlyWins: rows.filter(row => row.titleVariants['0.1']!.hit10 && !row.standard.hit10)
      .slice(0, 20).map(row => ({ group: row.group_id, query: row.query, parserTerms: row.parserTerms, goldIds: row.gold_ids, ftsTitleMatchesGold: ftsTitleMatchesGold.has(row.group_id), literalTitleTerms: exactTitleTerms(row) })),
    titleRrfOnlyLosses: rows.filter(row => !row.titleVariants['0.1']!.hit10 && row.standard.hit10)
      .slice(0, 20).map(row => ({ group: row.group_id, query: row.query, parserTerms: row.parserTerms, goldIds: row.gold_ids, ftsTitleMatchesGold: ftsTitleMatchesGold.has(row.group_id), literalTitleTerms: exactTitleTerms(row) })),
  },
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output: outputPath, overall: result.overall, byFtsTitleMatch: result.byFtsTitleMatch, titleCandidateCountThresholdSweep: result.titleCandidateCountThresholdSweep }, null, 2));
