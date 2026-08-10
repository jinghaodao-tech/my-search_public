import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'vitest';

type QualityArtifact = {
  decaySweep?: {
    floorProfiles?: Array<{ timeDecayFloor: number; pAt1ByLambda: Array<{ lambda: number; precisionAt1: number }>; passingRange?: { lambdaWidth?: number } | null }>;
  };
};

describe('search quality regression contract', () => {
  it('keeps a measurable time-decay passing window across the requested floor sweep', () => {
    const artifact = JSON.parse(fs.readFileSync('artifacts/search-quality.json', 'utf8')) as QualityArtifact;
    const profiles = artifact.decaySweep?.floorProfiles ?? [];
    assert.deepEqual(profiles.map(profile => profile.timeDecayFloor), [0.25, 0.3, 0.35, 0.4, 0.45, 0.5]);
    for (const profile of profiles) {
      assert.equal(profile.pAt1ByLambda.length, 41);
      assert.ok((profile.passingRange?.lambdaWidth ?? 0) > 0, `no passing window at floor ${profile.timeDecayFloor}`);
    }
    const production = profiles.find(profile => profile.timeDecayFloor === 0.35);
    assert.ok((production?.passingRange?.lambdaWidth ?? 0) > 0);
  });
});
