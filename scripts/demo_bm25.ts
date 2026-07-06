import { MODES, runPipeline, type Article } from '../bm25_engine.js';

const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const sampleArticles: Article[] = [
  {
    id: 'demo-1',
    title: 'SQLite-backed local search notes',
    body: 'BM25 search can rank local knowledge cards without sending private notes to a cloud service.',
    url: 'https://example.com/local-search',
    publishedAt: daysAgo(1),
    sourceAuthority: 0.8,
  },
  {
    id: 'demo-2',
    title: 'Frontend styling memo',
    body: 'A short note about card spacing, colors, and dashboard layout.',
    url: 'https://example.com/frontend-memo',
    publishedAt: daysAgo(3),
    sourceAuthority: 0.4,
  },
  {
    id: 'demo-3',
    title: 'BM25 token cache benchmark',
    body: 'Precomputed tokens_json and doc_length reduce repeated tokenizer work during search.',
    url: 'https://example.com/bm25-cache',
    publishedAt: daysAgo(0),
    sourceAuthority: 0.9,
  },
];

async function main(): Promise<void> {
  for (const [modeId, mode] of Object.entries(MODES)) {
    const result = await runPipeline(sampleArticles, mode, modeId, {
      archiveScoreThreshold: 0.3,
    });

    console.log('\n=== ' + mode.label + ' ===');
    console.table(result.active.map(item => ({
      id: item.article.id,
      title: item.article.title,
      score: item.score.toFixed(3),
    })));
    console.log('timings', result.stats.timings);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
