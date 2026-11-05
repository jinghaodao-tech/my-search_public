// Benchmark runner for the my-search page (served at /bench/runner.js when BENCH_DIR is set).
// In the app's page:  await import('/bench/runner.js'); runBench({ name: 'scifact' })
// Compares, for every judged question:
//   app             — the 探す screen's own words (/api/search/terms) → BM25
//   app+ai-synonyms — plus the on-device AI's synonyms, added as the app's 「AIで言い換え」 does
//   app+ai-queries  — plus searches with the on-device AI's queries, fused by reciprocal rank
// Progress is kept in localStorage, so a run can be resumed after a reload.

const K = 100;

function dcg(gains) { return gains.reduce((sum, gain, i) => sum + (2 ** gain - 1) / Math.log2(i + 2), 0); }
export function metrics(ranking, judged) {
  const rel = id => judged[id] ?? 0;
  const top10 = ranking.slice(0, 10);
  const ideal = Object.values(judged).filter(g => g > 0).sort((a, b) => b - a).slice(0, 10);
  const firstHit = ranking.findIndex(id => rel(id) > 0);
  const relevant = Object.keys(judged).filter(id => judged[id] > 0);
  return {
    ndcg10: ideal.length ? dcg(top10.map(rel)) / dcg(ideal) : 0,
    mrr10: firstHit >= 0 && firstHit < 10 ? 1 / (firstHit + 1) : 0,
    recall100: relevant.length ? relevant.filter(id => ranking.slice(0, K).includes(id)).length / relevant.length : 0,
  };
}

function rrf(rankings, k = 60) {
  const score = new Map();
  for (const ranking of rankings) ranking.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

async function search(keywords, data) {
  const result = await api.post('/api/run', {
    config: { label: 'bench', k1: 1.2, b: 0.75, lambda: 0, contextBonus: 1.2, keywords: keywords.map(k => ({ term: k.term, weight: k.weight, synonyms: [] })) },
    options: { resultLimit: K, archiveScoreThreshold: 0 },
    filters: { sources: [data.source], excludedTerms: [], status: 'all' },
  });
  return [...(result.active || []), ...(result.archived || [])]
    .sort((a, b) => b.score - a.score)
    .map(item => item.article.id.startsWith(data.idPrefix) ? item.article.id.slice(data.idPrefix.length) : item.article.id)
    .slice(0, K);
}

const terms = async text => (await api.post('/api/search/terms', { text })).keywords;

export async function runBench({ name, limit = 0, modes = ['app', 'app+ai-synonyms', 'app+ai-queries'], reset = false } = {}) {
  const data = await (await fetch(`/bench/${name}.eval.json`)).json();
  const key = `bench:${name}`;
  let saved = {};
  try { saved = reset ? {} : JSON.parse(localStorage.getItem(key) || '{}'); } catch { saved = {}; }
  const queries = limit ? data.queries.slice(0, limit) : data.queries;
  const aiReady = typeof localAi !== 'undefined' && await localAi.isReady('prompt').catch(() => false);
  if (!aiReady && modes.some(m => m.includes('ai'))) console.warn('on-device AI is not ready: AI modes are skipped');
  const state = window.__bench = { name, total: queries.length, done: Object.keys(saved).length, running: true, aiReady };
  for (const query of queries) {
    if (saved[query.id]) continue;
    const judged = data.qrels[query.id] || {};
    const row = { q: query.text };
    let t0 = performance.now();
    const base = await terms(query.text);
    const baseRanking = base.length ? await search(base, data) : [];
    row.app = { ...metrics(baseRanking, judged), ms: Math.round(performance.now() - t0), words: base.map(k => k.term) };
    if (aiReady && modes.includes('app+ai-synonyms')) {
      t0 = performance.now();
      let synonyms = [];
      try { synonyms = await localAi.expandKeywords(base.map(k => k.term)); } catch (e) { row.synError = String(e); }
      const aiMs = Math.round(performance.now() - t0);
      const seen = new Set(base.map(k => k.term.toLowerCase()));
      const added = synonyms.filter(t => !seen.has(t.toLowerCase())).map(term => ({ term, weight: 1 }));
      const ranking = added.length ? await search([...base, ...added], data) : baseRanking;
      row['app+ai-synonyms'] = { ...metrics(ranking, judged), ms: Math.round(performance.now() - t0), aiMs, added: added.map(k => k.term) };
    }
    if (aiReady && modes.includes('app+ai-queries')) {
      t0 = performance.now();
      let queriesByAi = [];
      try { queriesByAi = await localAi.makeQueries(query.text); } catch (e) { row.queryError = String(e); }
      const aiMs = Math.round(performance.now() - t0);
      const rankings = [baseRanking];
      for (const q of queriesByAi) { const words = await terms(q); if (words.length) rankings.push(await search(words, data)); }
      row['app+ai-queries'] = { ...metrics(rrf(rankings).slice(0, K), judged), ms: Math.round(performance.now() - t0), aiMs, queries: queriesByAi };
    }
    saved[query.id] = row;
    try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* keep in memory */ }
    state.done = Object.keys(saved).length;
  }
  state.running = false;
  state.summary = summarize(saved);
  return state.summary;
}

export function summarize(saved) {
  const rows = Object.values(saved);
  const out = {};
  for (const mode of ['app', 'app+ai-synonyms', 'app+ai-queries']) {
    const list = rows.map(row => row[mode]).filter(Boolean);
    if (!list.length) continue;
    const mean = key => Number((list.reduce((s, r) => s + (r[key] || 0), 0) / list.length).toFixed(4));
    out[mode] = { queries: list.length, ndcg10: mean('ndcg10'), mrr10: mean('mrr10'), recall100: mean('recall100'), msPerQuery: Math.round(mean('ms')), aiMsPerQuery: list[0].aiMs !== undefined ? Math.round(mean('aiMs')) : undefined };
  }
  // per question: how often AI helped / hurt nDCG@10
  for (const mode of ['app+ai-synonyms', 'app+ai-queries']) {
    const pairs = rows.filter(row => row[mode]);
    if (!pairs.length) continue;
    out[mode].better = pairs.filter(row => row[mode].ndcg10 > row.app.ndcg10 + 1e-9).length;
    out[mode].worse = pairs.filter(row => row[mode].ndcg10 < row.app.ndcg10 - 1e-9).length;
  }
  return out;
}

export function benchResults(name) { try { return JSON.parse(localStorage.getItem(`bench:${name}`) || '{}'); } catch { return {}; } }
window.runBench = runBench;
window.benchResults = benchResults;
window.benchSummary = name => summarize(benchResults(name));
