import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

export function captureGitState(repositoryRoot = process.cwd()) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot, encoding: 'utf8' });
  return {
    head,
    workingTreeDirty: status.length > 0,
    statusSha256: sha256(status),
    statusPathsRecorded: false,
  };
}

export function captureHostState() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.version,
    cpuModel: cpus[0]?.model ?? null,
    logicalCpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

export function captureEffectiveSearchParameters({ method, mode, modeId = null, resultLimit, archiveScoreThreshold, dedupThreshold,
  pipelineEngine = 'bm25', bm25Weight, ftsWeight, timeDecayFloor, e5CandidateCount }) {
  const bm25 = {
    k1: mode.k1,
    b: mode.b,
    lambda: mode.lambda,
    contextBonus: mode.contextBonus,
    timeDecayFloor: timeDecayFloor ?? 0.35,
    timeDecayHalfLifeDays: mode.lambda > 0 ? Math.LN2 / mode.lambda : null,
    explicitMorphologicalWeight: mode.morphologicalWeight ?? null,
    explicitNgramWeight: mode.ngramWeight ?? null,
    fallbackMorphologicalWeight: mode.morphologicalWeight ?? 0.3,
    fallbackNgramWeight: mode.ngramWeight ?? 0.7,
  };
  return {
    queryAnalysis: { endpoint: '/api/search/terms', mode: 'application query analyzer', queryTextRecorded: false },
    retrieval: { endpoint: '/api/cards/search', requestedEngine: method, pipelineEngine },
    mode: {
      id: modeId ?? mode.id ?? null,
      source: modeId ? 'selected /api/modes entry' : 'inline frozen mode object',
      description: mode.description ?? null,
      bm25Parameters: bm25,
      bm25ParametersAppliedWhen: 'API response actualEngine identifies whether the BM25 path or an FTS-only path ran; FTS-only ranking does not consume these BM25 weights or time decay.',
    },
    synthesis: {
      configuredEngine: method,
      pipelineEngine,
      hybridWeights: pipelineEngine === 'hybrid'
        ? { bm25: bm25Weight ?? 0.7, fts5: ftsWeight ?? 0.3 }
        : null,
      reciprocalRankConstant: 60,
      rrfContributions: 'recorded from each actual response scoreSources; engine-specific fallbacks remain separate',
    },
    options: {
      resultLimit: resultLimit ?? 50,
      archiveScoreThreshold: archiveScoreThreshold ?? 0.5,
      dedupThreshold: dedupThreshold ?? 1,
      timeDecayFloor: timeDecayFloor ?? 0.35,
      bm25Weight: pipelineEngine === 'hybrid' ? (bm25Weight ?? 0.7) : null,
      ftsWeight: pipelineEngine === 'hybrid' ? (ftsWeight ?? 0.3) : null,
      e5CandidateCount: method === 'e5-rrf' ? (e5CandidateCount ?? 100) : null,
    },
  };
}

export function summarizeObservedSearchMethods(observations) {
  const actualEngines = [...new Set(observations.map(row => row.actualEngine).filter(value => typeof value === 'string'))].sort();
  const scoringMethods = [...new Set(observations.flatMap(row => row.scoringMethods ?? []))].sort();
  return { actualEngines, scoringMethods,
    fallbackCount: observations.filter(row => row.fallbackUsed === true).length,
    responseCount: observations.length };
}

export function relativePathFromRoot(file, repositoryRoot = process.cwd()) {
  return path.relative(repositoryRoot, file).replaceAll(path.sep, '/');
}
