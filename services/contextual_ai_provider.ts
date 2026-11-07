/** Typed boundary for contextual AI work. Providers never receive authority to mutate cards or execute code. */
export type ContextualCapability = 'search_terms' | 'related_passages' | 'article_summary' | 'typed_tool_proposal' | 'outline_proposal' | 'cross_source_comparison' | 'claim_evidence_review' | 'rewrite_selection';
export type ContextualProcessor = 'rules' | 'chrome_local' | 'configured_server' | 'mock' | 'future_browser';
export type ContextualVerification = 'not_applicable' | 'unverified_generation' | 'exact_source_checked' | 'rejected';

export type ContextualSource = {
  id: string;
  version: string;
  paragraphIndices?: number[];
};

export type ContextualInputByCapability = {
  search_terms: { query: string };
  related_passages: { purpose: string; paragraphs: string[] };
  article_summary: { title: string; paragraphs: string[]; purpose?: string };
  typed_tool_proposal: { paragraph: string; paragraphIndex: number };
  outline_proposal: { title: string; purpose: string; citations: Array<{ id: string; sourceTitle: string; quote: string; verification: string }> };
  cross_source_comparison: { purpose: string; sources: Array<{ id: string; title: string; citations: Array<{ citationId: string; quote: string }> }> };
  claim_evidence_review: { claim: string; citations: Array<{ citationId: string; sourceTitle: string; quote: string; verification: string }> };
  rewrite_selection: { selection: string; purpose?: string; citations: Array<{ sourceTitle: string; quote: string; verification: string }> };
};

export type ContextualOutputByCapability = {
  search_terms: { suggestions: string[] };
  related_passages: {
    rows: Array<{ claim: string; quote: string; paragraphIndex: number; [key: string]: unknown }>;
    rejected?: Array<Record<string, unknown>>;
    chunks?: number;
    method?: string;
    sources?: Array<{ id: string; title: string; url?: string | null }>;
    claims?: Array<{ claim: string; quote: string; paragraphIndex: number }>;
  };
  article_summary: {
    summary: string;
    citations: Array<{ quote: string; paragraphIndex: number }>;
    rows?: Array<{ claim: string; quote: string; paragraphIndex: number; [key: string]: unknown }>;
    rejected?: Array<Record<string, unknown>>;
  };
  typed_tool_proposal: { supported: boolean; proposal: unknown };
  outline_proposal: { markdown: string };
  cross_source_comparison: { markdown: string };
  claim_evidence_review: { review: string };
  rewrite_selection: { rewrite: string };
};

export type ContextualRequest<C extends ContextualCapability = ContextualCapability> = {
  capability: C;
  input: ContextualInputByCapability[C];
  source: ContextualSource;
};

export type ContextualResult<C extends ContextualCapability = ContextualCapability> = {
  capability: C;
  status: 'ok' | 'unavailable' | 'cancelled' | 'error';
  processor: ContextualProcessor;
  modelVersion: string | null;
  source: ContextualSource;
  verification: ContextualVerification;
  output?: ContextualOutputByCapability[C];
  failureReason?: string;
};

export interface ContextualAiProvider {
  readonly processor: ContextualProcessor;
  readonly modelVersion: string | null;
  supports(capability: ContextualCapability): boolean;
  available(capability: ContextualCapability, signal?: AbortSignal): Promise<{ available: boolean; reason?: string }>;
  execute(request: ContextualRequest, signal?: AbortSignal): Promise<ContextualResult>;
}

/** Data passed by the Reader to the browser-side contextual capability broker. */
export type ContextualArticle = {
  id?: string;
  url?: string | null;
  title?: string;
  toolsSourceHash?: string;
  fetchedAt?: string;
  paragraphs: string[];
};

export type ContextualEvidenceEngine = 'words' | 'local-ai' | 'server-ai' | 'mock';

/** Consumer-facing browser API used by the existing classic-script UI. */
export interface ContextualAiClient {
  queryTerms(keywords: string[], signal?: AbortSignal): Promise<ContextualResult<'search_terms'>>;
  relatedPassages(engine: ContextualEvidenceEngine, purpose: string, article: ContextualArticle, signal?: AbortSignal): Promise<ContextualResult<'related_passages'>>;
  articleSummary(engine: ContextualEvidenceEngine, purpose: string, article: ContextualArticle, signal?: AbortSignal): Promise<ContextualResult<'article_summary'>>;
  proposeTool(paragraph: string, paragraphIndex: number, article: ContextualArticle, signal?: AbortSignal): Promise<ContextualResult<'typed_tool_proposal'>>;
  proposeOutline(title: string, purpose: string, citations: ContextualInputByCapability['outline_proposal']['citations'], signal?: AbortSignal): Promise<ContextualResult<'outline_proposal'>>;
  compareSources(purpose: string, sources: ContextualInputByCapability['cross_source_comparison']['sources'], signal?: AbortSignal): Promise<ContextualResult<'cross_source_comparison'>>;
  reviewClaim(claim: string, citations: ContextualInputByCapability['claim_evidence_review']['citations'], signal?: AbortSignal): Promise<ContextualResult<'claim_evidence_review'>>;
  rewriteSelection(selection: string, purpose: string, citations: ContextualInputByCapability['rewrite_selection']['citations'], signal?: AbortSignal): Promise<ContextualResult<'rewrite_selection'>>;
  sourceFor(article: ContextualArticle, paragraphIndices?: number[]): ContextualSource;
}

export type ContextualAdapter<C extends ContextualCapability> = {
  processor: ContextualProcessor;
  modelVersion?: string | null;
  available?: (capability: C, signal?: AbortSignal) => Promise<{ available: boolean; reason?: string }>;
  execute: (request: ContextualRequest<C>, signal?: AbortSignal) => Promise<{
    output: ContextualOutputByCapability[C];
    verification: ContextualVerification;
  }>;
};

/** Wrap an implementation while standardizing availability, cancellation, errors, and provenance. */
export function createContextualAdapter<C extends ContextualCapability>(
  capability: C,
  adapter: ContextualAdapter<C>,
): ContextualAiProvider {
  return {
    processor: adapter.processor,
    modelVersion: adapter.modelVersion ?? null,
    supports: candidate => candidate === capability,
    async available(candidate, signal) {
      if (String(candidate) !== String(capability)) return { available: false, reason: 'unsupported_capability' };
      if (signal?.aborted) return { available: false, reason: 'cancelled' };
      return adapter.available ? adapter.available(capability, signal) : { available: true };
    },
    async execute(request: ContextualRequest, signal?: AbortSignal): Promise<ContextualResult> {
      const source = request.source;
      if (String(request.capability) !== String(capability)) {
        return { capability: request.capability, status: 'unavailable', processor: adapter.processor, modelVersion: adapter.modelVersion ?? null, source, verification: 'not_applicable', failureReason: 'unsupported_capability' };
      }
      if (signal?.aborted) {
        return { capability: request.capability, status: 'cancelled', processor: adapter.processor, modelVersion: adapter.modelVersion ?? null, source, verification: 'not_applicable', failureReason: 'cancelled' };
      }
      const availability = await this.available(capability, signal);
      if (!availability.available) {
        return { capability: request.capability, status: signal?.aborted ? 'cancelled' : 'unavailable', processor: adapter.processor, modelVersion: adapter.modelVersion ?? null, source, verification: 'not_applicable', failureReason: availability.reason ?? 'unavailable' };
      }
      try {
        const result = await adapter.execute(request as unknown as ContextualRequest<C>, signal);
        if (signal?.aborted) return { capability: request.capability, status: 'cancelled', processor: adapter.processor, modelVersion: adapter.modelVersion ?? null, source, verification: 'not_applicable', failureReason: 'cancelled' };
        return { capability: request.capability, status: 'ok', processor: adapter.processor, modelVersion: adapter.modelVersion ?? null, source, verification: result.verification, output: result.output as ContextualOutputByCapability[typeof capability] };
      } catch (error) {
        return { capability: request.capability, status: signal?.aborted ? 'cancelled' : 'error', processor: adapter.processor, modelVersion: adapter.modelVersion ?? null, source, verification: 'not_applicable', failureReason: error instanceof Error ? error.message.slice(0, 300) : 'provider_error' };
      }
    },
  };
}
