import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const dataDir = path.resolve(process.argv[2] ?? 'quality/e2e/local/jaqket-public');
const priorPath = path.resolve(process.argv[3] ?? 'quality/e2e/local/jqara/runtime/test-866366b268f94451b34c14a453cfbe81c57499b0bc052e9bf1e02c5363012cfe.jsonl');
const outputPath = path.join(dataDir, 'overlap-audit.json');
if (!['dev1_questions.json', 'dev2_questions.json'].every(name => readFileSync(path.join(dataDir, name), 'utf8').length > 0)) {
  throw new Error('JAQKET dev1 and dev2 files are required.');
}
if (statSync(priorPath).size === 0) throw new Error('Prior JQaRA runtime records are required.');

const norm = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
const queryNorm = value => String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ja-JP');
const hash = value => createHash('sha256').update(value).digest('hex');
const load = split => readFileSync(path.join(dataDir, `${split}_questions.json`), 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
const splits = { dev1: load('dev1'), dev2: load('dev2') };
const priorQids = new Set();
const priorQueryHashes = new Set();
const priorGoldTitles = new Set();
for await (const line of readline.createInterface({ input: createReadStream(priorPath), crlfDelay: Infinity })) {
  if (!line) continue;
  const row = JSON.parse(line);
  priorQids.add(row.q_id);
  priorQueryHashes.add(hash(queryNorm(row.question)));
  if (row.label > 0) priorGoldTitles.add(norm(row.title));
}
const golds = row => (Array.isArray(row.answer_entity) ? row.answer_entity : [row.answer_entity]).map(norm);
const allDev1Targets = new Set(splits.dev1.flatMap(golds));
const splitSummaries = {};
for (const [split, rows] of Object.entries(splits)) {
  if (new Set(rows.map(row => row.qid)).size !== rows.length || rows.some(row => !row.qid || !row.question || !row.answer_entity)) throw new Error(`Invalid JAQKET ${split} questions.`);
  const priorArticleRows = rows.filter(row => golds(row).some(title => priorGoldTitles.has(title)));
  const afterPriorArticle = rows.filter(row => !priorArticleRows.includes(row));
  const earlierSplitRows = split === 'dev2' ? afterPriorArticle.filter(row => golds(row).some(title => allDev1Targets.has(title))) : [];
  const eligible = afterPriorArticle.filter(row => !earlierSplitRows.includes(row));
  splitSummaries[split] = {
    queries: rows.length,
    uniqueTargetGroups: new Set(rows.flatMap(golds)).size,
    qidOverlapWithPriorJQaRA: rows.filter(row => priorQids.has(row.qid)).length,
    normalizedQuestionOverlapWithPriorJQaRA: rows.filter(row => priorQueryHashes.has(hash(queryNorm(row.question)))).length,
    queriesWithPriorJQaRAPositiveTargetOverlap: priorArticleRows.length,
    priorOverlappingTargetGroups: new Set(priorArticleRows.flatMap(golds).filter(title => priorGoldTitles.has(title))).size,
    queriesWithEarlierDevTargetOverlap: earlierSplitRows.length,
    eligibleQueriesAfterExclusions: eligible.length,
    eligibleTargetGroupsAfterExclusions: new Set(eligible.flatMap(golds)).size,
  };
}
const dev1Hashes = new Set(splits.dev1.map(row => hash(queryNorm(row.question))));
const dev1Qids = new Set(splits.dev1.map(row => row.qid));
const output = {
  generatedAt: new Date().toISOString(),
  sources: {
    jaqketOfficial: 'https://www.nlp.ecei.tohoku.ac.jp/projects/jaqket/',
    priorJQaRAPath: path.basename(priorPath),
    dev1Sha256: hash(readFileSync(path.join(dataDir, 'dev1_questions.json'))),
    dev2Sha256: hash(readFileSync(path.join(dataDir, 'dev2_questions.json'))),
    priorJQaRAUniqueQids: priorQids.size,
    priorJQaRAUniqueNormalizedQuestions: priorQueryHashes.size,
    priorJQaRAPositiveTargetGroups: priorGoldTitles.size,
  },
  splitOverlap: {
    qid: splits.dev2.filter(row => dev1Qids.has(row.qid)).length,
    normalizedQuestion: splits.dev2.filter(row => dev1Hashes.has(hash(queryNorm(row.question)))).length,
    sharedTargetGroups: [...new Set(splits.dev2.flatMap(golds))].filter(title => allDev1Targets.has(title)).length,
    dev2QueriesWithSharedTargetGroups: splits.dev2.filter(row => golds(row).some(title => allDev1Targets.has(title))).length,
  },
  splits: splitSummaries,
  evaluationRole: 'public development-only proxy; quiz QA, not saved-article memory refinding',
  includesRawQueriesOrTitles: false,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputPath, splitOverlap: output.splitOverlap, splits: output.splits }, null, 2));
