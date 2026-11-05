export type Posting = { docIndex: number; tf: number };
export type AdaptiveTermModel = {
  df: number;
  standardIdf: number;
  informationGainIdf: number;
  adaptiveK1: number;
  fitPoints: number;
};

const log2 = (value: number) => Math.log(value) / Math.LN2;

export function buildAdaptiveTermModel(documentCount: number, normalized: number[]): AdaptiveTermModel | null {
  const df = normalized.length;
  if (!df) return null;
  let maximum = 1;
  for (const value of normalized) maximum = Math.max(maximum, value);
  const maxThreshold = Math.min(64, Math.ceil(maximum + 1));
  const dft = new Array<number>(maxThreshold + 1).fill(0);
  dft[0] = documentCount;
  dft[1] = df;
  for (let threshold = 2; threshold <= maxThreshold; threshold++) {
    const boundary = threshold - 0.5;
    let count = 0;
    for (const value of normalized) if (value >= boundary) count++;
    dft[threshold] = count;
  }

  const initialProbability = (df + 0.5) / (documentCount + 1);
  const informationGain = new Array<number>(maxThreshold).fill(0);
  for (let occurrence = 0; occurrence < maxThreshold; occurrence++) {
    const currentDf = dft[occurrence] ?? 0;
    const nextDf = dft[occurrence + 1] ?? 0;
    const nextProbability = (nextDf + 0.5) / (currentDf + 1);
    informationGain[occurrence] = -log2(initialProbability) + log2(nextProbability);
  }

  const informationGainIdf = informationGain[1] ?? 0;
  let terminalOccurrence = 1;
  for (let occurrence = 1; occurrence + 1 < informationGain.length; occurrence++) {
    if (informationGain[occurrence]! > informationGain[occurrence + 1]!) {
      terminalOccurrence = occurrence;
      break;
    }
    terminalOccurrence = occurrence + 1;
  }

  const fitPoints: Array<{ tf: number; normalizedGain: number }> = [];
  if (informationGainIdf > 0) {
    for (let occurrence = 2; occurrence <= terminalOccurrence; occurrence++) {
      fitPoints.push({ tf: occurrence, normalizedGain: informationGain[occurrence]! / informationGainIdf });
    }
  }
  return {
    df,
    standardIdf: Math.log(1 + (documentCount - df + 0.5) / (df + 0.5)),
    informationGainIdf,
    adaptiveK1: fitPoints.length ? fitK1(fitPoints) : 1.2,
    fitPoints: fitPoints.length,
  };
}

function fitK1(points: Array<{ tf: number; normalizedGain: number }>): number {
  let bestK1 = 1.2;
  let bestError = Number.POSITIVE_INFINITY;
  for (let step = 1; step <= 400; step++) {
    const k1 = step * 0.05;
    let error = 0;
    for (const point of points) {
      const estimate = ((k1 + 1) * point.tf) / (k1 + point.tf);
      const difference = point.normalizedGain - estimate;
      error += difference * difference;
    }
    if (error < bestError) {
      bestError = error;
      bestK1 = k1;
    }
  }
  return bestK1;
}

export function buildAdaptiveTermModels(
  documentCount: number,
  averageLength: number,
  lengths: number[],
  postings: Map<string, Posting[]>,
  b = 0.75,
): Map<string, AdaptiveTermModel> {
  const models = new Map<string, AdaptiveTermModel>();
  for (const [term, rows] of postings) {
    const normalized = rows.map(row => row.tf / (1 - b + b * lengths[row.docIndex]! / Math.max(averageLength, 1)));
    const model = buildAdaptiveTermModel(documentCount, normalized);
    if (model) models.set(term, model);
  }
  return models;
}

export function scoreAdaptiveBm25(
  terms: readonly string[],
  documentCount: number,
  averageLength: number,
  lengths: number[],
  postings: Map<string, Posting[]>,
  models: Map<string, AdaptiveTermModel>,
  mode: 'standard' | 'adaptive-k1' | 'bm25-adpt',
  b = 0.75,
): Array<{ docIndex: number; score: number }> {
  const scores = new Map<number, number>();
  for (const term of new Set(terms)) {
    const rows = postings.get(term);
    const model = models.get(term);
    if (!rows?.length || !model) continue;
    const idf = mode === 'bm25-adpt' ? model.informationGainIdf : model.standardIdf;
    if (!(idf > 0)) continue;
    const k1 = mode === 'standard' ? 1.2 : model.adaptiveK1;
    for (const row of rows) {
      const normalizedTf = row.tf / (1 - b + b * lengths[row.docIndex]! / Math.max(averageLength, 1));
      const tfScore = (normalizedTf * (k1 + 1)) / (normalizedTf + k1);
      scores.set(row.docIndex, (scores.get(row.docIndex) ?? 0) + idf * tfScore);
    }
  }
  return [...scores].map(([docIndex, score]) => ({ docIndex, score })).sort((left, right) => right.score - left.score || left.docIndex - right.docIndex);
}
