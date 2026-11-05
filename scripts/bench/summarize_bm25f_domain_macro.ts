import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type PerQuery = { groupId: string; metrics: Record<string, Record<string, number>> };
type Input = { dataset: { name: string; groups: number }; definitions: { selectedCandidate: string }; means: Record<string, Record<string, number>>; perQuery: PerQuery[] };
const [booksArg, moviesArg, outputArg] = process.argv.slice(2);
if (!booksArg || !moviesArg || !outputArg) throw new Error('Usage: tsx scripts/bench/summarize_bm25f_domain_macro.ts <books-result.json> <movies-result.json> <new-output.json>');
const books = JSON.parse(fs.readFileSync(path.resolve(booksArg), 'utf8')) as Input;
const movies = JSON.parse(fs.readFileSync(path.resolve(moviesArg), 'utf8')) as Input;
const output = path.resolve(outputArg);
if (fs.existsSync(output) || !output.includes(`${path.sep}artifacts${path.sep}`)) throw new Error('Output must be new and under artifacts/.');
const inputs = [books, movies];
if (inputs.some(input => !input.definitions.selectedCandidate || input.perQuery.length !== input.dataset.groups)) throw new Error('Input summary or query groups are inconsistent.');
const bookGroups = new Set(books.perQuery.map(row => row.groupId));
if (movies.perQuery.some(row => bookGroups.has(row.groupId))) throw new Error('Target groups overlap across the two domains.');
const metrics = ['hit1', 'hit10', 'recall100', 'mrr10', 'ndcg10', 'map100'] as const;
const paired = inputs.map(input => {
  const candidate = input.definitions.selectedCandidate;
  return { name: input.dataset.name, differences: Object.fromEntries(metrics.map(metric => [metric,
    input.perQuery.map(row => row.metrics[candidate]![metric]! - row.metrics.standard![metric]!)])) };
});
const results = Object.fromEntries(metrics.map(metric => {
  const domainMeans = paired.map(domain => domain.differences[metric]!.reduce((sum, value) => sum + value, 0) / domain.differences[metric]!.length);
  const mean = domainMeans.reduce((sum, value) => sum + value, 0) / domainMeans.length;
  const seedSource = `bm25f-equal-domain-macro-${metric}`;
  let seed = Number.parseInt(crypto.createHash('sha256').update(seedSource).digest('hex').slice(0, 8), 16) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
  const draws = new Array<number>(10_000);
  for (let draw = 0; draw < draws.length; draw++) {
    const sampleMeans = paired.map(domain => {
      const values = domain.differences[metric]!;
      let sum = 0;
      for (let index = 0; index < values.length; index++) sum += values[Math.floor(random() * values.length)]!;
      return sum / values.length;
    });
    draws[draw] = sampleMeans.reduce((sum, value) => sum + value, 0) / sampleMeans.length;
  }
  draws.sort((a, b) => a - b);
  return [metric, { equalDomainMeanDifference: mean, domainMeanDifferences: Object.fromEntries(paired.map((domain, index) => [domain.name, domainMeans[index]])),
    stratifiedClusterBootstrap95CI: [draws[249]!, draws[9_749]!], replicates: draws.length, clusterCounts: Object.fromEntries(paired.map(domain => [domain.name, domain.differences[metric]!.length])) }];
}));
const result = { method: 'Equal-weight macro-average of per-domain paired metric differences; independently resample target groups within each domain.',
  domains: inputs.map(input => ({ name: input.dataset.name, groups: input.dataset.groups, candidate: input.definitions.selectedCandidate })),
  exploratoryOnly: true, note: 'Books selected titleWeight=2 on its development split; Movies had prior exploratory exposure. This is not an independent confirmatory estimate.', metrics: results };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, metrics: result.metrics }, null, 2));
