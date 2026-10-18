import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { precisionAt, searchQualityMetricReferences } from '../scripts/search_quality_metrics.js';

describe('search quality metric definitions', () => {
  it('penalizes fewer than k returned results using the standard k denominator', () => {
    assert.equal(precisionAt(['hit'], ['hit'], 3), 1 / 3);
    assert.equal(precisionAt([], ['hit'], 3), 0);
    assert.equal(precisionAt(['hit', 'miss', 'miss'], ['hit'], 3), 1 / 3);
  });

  it('keeps a reference definition for every reported metric', () => {
    assert.deepEqual(Object.keys(searchQualityMetricReferences).sort(), ['mrr', 'ndcgAt5', 'precisionAt1', 'rPrecision', 'recallAt5'].sort());
    for (const definition of Object.values(searchQualityMetricReferences)) assert.ok(definition.length > 20);
  });
});
