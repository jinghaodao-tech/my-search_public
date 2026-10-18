export const searchQualityThresholds = {
  precisionAt1: 0.75,
  rPrecision: 0.75,
  mrr: 0.8,
  recallAt5: 0.8,
  ndcgAt5: 0.75,
} as const;

export const realQualityGateThresholds = {
  precisionAt1: 0.7,
} as const;

export type SearchQualityMetricName = keyof typeof searchQualityThresholds;
export type SearchQualityMetrics = Record<SearchQualityMetricName, number>;

// The implementation-level reference text is exported from
// search_quality_metrics.ts so artifacts and tests use the same metric map.

export function assertSearchQualityMetrics(
  scope: string,
  metrics: Partial<SearchQualityMetrics>,
): void {
  for (const [metric, threshold] of Object.entries(searchQualityThresholds)) {
    const actual = metrics[metric as keyof SearchQualityMetrics];
    if (typeof actual !== 'number' || actual < threshold) {
      throw new Error(`${scope} ${metric}=${String(actual)} is below threshold ${threshold}`);
    }
  }
}
