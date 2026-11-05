import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEffectiveSearchParameters, summarizeObservedSearchMethods } from '../scripts/bench/search_run_provenance.mjs';

test('provenance separates explicit BM25 weights from per-path fallback values and decay', () => {
  const inherited = captureEffectiveSearchParameters({ method: 'fts5-morph', mode: { id: 'default', k1: 1.2, b: 0.75, lambda: 0, contextBonus: 1.2 }, resultLimit: 50 });
  assert.equal(inherited.mode.bm25Parameters.explicitMorphologicalWeight, null);
  assert.equal(inherited.mode.bm25Parameters.fallbackMorphologicalWeight, 0.3);
  assert.equal(inherited.mode.bm25Parameters.fallbackNgramWeight, 0.7);
  assert.equal(inherited.mode.bm25Parameters.timeDecayHalfLifeDays, null);
  assert.equal(inherited.mode.bm25Parameters.timeDecayFloor, 0.35);
  assert.equal(inherited.options.resultLimit, 50);
  assert.equal(inherited.options.e5CandidateCount, null);
  assert.equal(inherited.retrieval.pipelineEngine, 'bm25');
  assert.equal(inherited.synthesis.hybridWeights, null);
  assert.match(inherited.mode.bm25ParametersAppliedWhen, /FTS-only ranking does not consume/);

  const explicit = captureEffectiveSearchParameters({ method: 'like', mode: { k1: 1.2, b: 0.3, lambda: Math.LN2 / 730, contextBonus: 1.2, morphologicalWeight: 0.5, ngramWeight: 0.5 } });
  assert.equal(explicit.mode.bm25Parameters.explicitMorphologicalWeight, 0.5);
  assert.equal(explicit.mode.bm25Parameters.fallbackMorphologicalWeight, 0.5);
  assert.equal(explicit.mode.bm25Parameters.timeDecayHalfLifeDays, 730);
  assert.equal(explicit.synthesis.reciprocalRankConstant, 60);
  const custom = captureEffectiveSearchParameters({ method: 'e5-rrf', mode: { k1: 1, b: 0.5, lambda: 0.01, contextBonus: 1 },
    timeDecayFloor: 0.2, e5CandidateCount: 240, resultLimit: 20 });
  assert.equal(custom.mode.bm25Parameters.timeDecayFloor, 0.2);
  assert.equal(custom.options.e5CandidateCount, 240);
  const hybrid = captureEffectiveSearchParameters({ method: 'like', pipelineEngine: 'hybrid', bm25Weight: 0.6, ftsWeight: 0.4,
    mode: { k1: 1, b: 0.5, lambda: 0, contextBonus: 1 } });
  assert.deepEqual(hybrid.synthesis.hybridWeights, { bm25: 0.6, fts5: 0.4 });
});

test('observed engine fallbacks and score functions remain separately visible', () => {
  assert.deepEqual(summarizeObservedSearchMethods([
    { actualEngine: 'fts5-morph-saved-cards', fallbackUsed: false, scoringMethods: ['sqlite-fts5-morphological-bm25'] },
    { actualEngine: 'fts5-morph-fallback-rrf-saved-cards', fallbackUsed: true, scoringMethods: ['sqlite-fts5-rrf'] },
  ]), {
    actualEngines: ['fts5-morph-fallback-rrf-saved-cards', 'fts5-morph-saved-cards'],
    scoringMethods: ['sqlite-fts5-morphological-bm25', 'sqlite-fts5-rrf'],
    fallbackCount: 1,
    responseCount: 2,
  });
});
