import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'vitest';

type QualityArtifact = {
  decaySweep?: {
    floorProfiles?: Array<{ timeDecayFloor: number; pAt1ByLambda: Array<{ lambda: number; precisionAt1: number; bothPass: boolean; fullQualityPass: boolean }>; passingRange?: { minLambda: number; maxLambda: number; lambdaWidth: number; count: number } | null }>;
  };
};

describe('search quality regression contract', () => {
  // artifacts/search-quality.json is made by `npm run evaluate:search`; skip (and say so) when it has not been made.
  it.skipIf(!fs.existsSync('artifacts/search-quality.json'))('keeps a measurable time-decay passing window across the requested floor sweep (needs artifacts/search-quality.json)', () => {
    const artifact = JSON.parse(fs.readFileSync('artifacts/search-quality.json', 'utf8')) as QualityArtifact;
    const profiles = artifact.decaySweep?.floorProfiles ?? [];
    assert.deepEqual(profiles.map(profile => profile.timeDecayFloor), [0.25, 0.3, 0.35, 0.4, 0.45, 0.5]);
    for (const profile of profiles) {
      assert.equal(profile.pAt1ByLambda.length, 41);
      // A diagnostic sweep must report narrow or absent windows honestly, not require every
      // experimental floor to work. The production default below must still have real width.
      const passing = profile.pAt1ByLambda.filter(row => row.bothPass);
      if (!passing.length) assert.equal(profile.passingRange, null);
      else {
        const minLambda = Math.min(...passing.map(row => row.lambda));
        const maxLambda = Math.max(...passing.map(row => row.lambda));
        assert.deepEqual(profile.passingRange, { minLambda, maxLambda, lambdaWidth: Number((maxLambda - minLambda).toFixed(3)), count: passing.length });
      }
    }
    const production = profiles.find(profile => profile.timeDecayFloor === 0.35);
    assert.ok((production?.passingRange?.lambdaWidth ?? 0) > 0);
  });
});
