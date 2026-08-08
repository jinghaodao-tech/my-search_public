export const searchQualityThresholds = {
  precisionAt1: 0.75,
  precisionAt3: 0.45,
  mrr: 0.8,
  recallAt5: 0.8,
  ndcgAt5: 0.75,
} as const;

export type SearchQualityMetricName = keyof typeof searchQualityThresholds;
export type SearchQualityMetrics = Record<SearchQualityMetricName, number>;

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
