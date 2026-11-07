// Browser-side adapters for the contextual capability contract.
// @ts-check
// All model calls begin after an explicit user action; article text is never sent by state detection.
(function (root) {
  'use strict';

  // Keep the classic-script boundary explicit while exposing the actual UI calls to TS checking.
  const apiClient = root.mySearchContextualApi || root.api;
  const featureState = () => root.getMySearchContextualFeatures?.() || root.appFeatures;

  /**
   * @typedef {'search_terms'|'related_passages'|'article_summary'|'typed_tool_proposal'} ContextualCapability
   * @typedef {'rules'|'chrome_local'|'configured_server'|'mock'|'future_browser'} ContextualProcessor
   * @typedef {{id:string, version:string, paragraphIndices?:number[]}} ContextualSource
   * @typedef {{capability:ContextualCapability,status:'ok'|'unavailable'|'cancelled'|'error',processor:ContextualProcessor,modelVersion:string|null,source:ContextualSource,verification:'not_applicable'|'unverified_generation'|'exact_source_checked'|'rejected',output?:object,failureReason?:string}} ContextualResult
   */
  /**
   * @template {import('../../services/contextual_ai_provider.js').ContextualCapability} C
   * @param {C} capability
   * @param {import('../../services/contextual_ai_provider.js').ContextualResult<C>['status']} status
   * @param {import('../../services/contextual_ai_provider.js').ContextualProcessor} processor
   * @param {import('../../services/contextual_ai_provider.js').ContextualSource} source
   * @param {import('../../services/contextual_ai_provider.js').ContextualVerification} verification
   * @param {import('../../services/contextual_ai_provider.js').ContextualResult<C>['output']} [output]
   * @param {string} [failureReason]
   * @returns {import('../../services/contextual_ai_provider.js').ContextualResult<C>}
   */
  function result(capability, status, processor, source, verification, output, failureReason) {
    return { capability: capability, status: status, processor: processor, modelVersion: null, source: source, verification: verification, output: output, failureReason: failureReason };
  }

  /** @param {import('../../services/contextual_ai_provider.js').ContextualArticle} article
   *  @param {number[]} [paragraphIndices]
   *  @returns {import('../../services/contextual_ai_provider.js').ContextualSource} */
  function sourceFor(article, paragraphIndices) {
    return {
      id: String(article?.id || article?.url || article?.title || 'reader-unsaved'),
      version: String(article?.toolsSourceHash || article?.fetchedAt || 'version-unavailable'),
      ...(paragraphIndices ? { paragraphIndices: paragraphIndices.slice() } : {}),
    };
  }

  /** @param {string[]} keywords
   *  @param {AbortSignal} [signal]
   *  @returns {Promise<import('../../services/contextual_ai_provider.js').ContextualResult<'search_terms'>>} */
  async function queryTerms(keywords, signal) {
    const source = { id: 'search-query', version: 'current-input' };
    if (signal?.aborted) return result('search_terms', 'cancelled', 'rules', source, 'not_applicable', undefined, 'cancelled');
    /** @type {import('../../services/contextual_ai_provider.js').ContextualProcessor} */
    let processor = 'rules';
    try {
      if (typeof root.localAi !== 'undefined' && (await root.localAi.availability('prompt')) !== 'unavailable') {
        processor = 'chrome_local';
        const suggestions = await root.localAi.expandKeywords(keywords, { signal: signal });
        return result('search_terms', 'ok', 'chrome_local', source, 'unverified_generation', { suggestions });
      }
      if (featureState()?.ai) {
        processor = featureState()?.aiMode === 'mock' ? 'mock' : 'configured_server';
        const response = await apiClient.post('/api/search/expand-keywords', { keywords }, { signal: signal });
        return result('search_terms', 'ok', processor, source, 'unverified_generation', { suggestions: response.expandedKeywords || [] });
      }
      return result('search_terms', 'unavailable', 'rules', source, 'not_applicable', undefined, 'no_ai_provider');
    } catch (error) {
      return result('search_terms', signal?.aborted ? 'cancelled' : 'error', processor, source, 'not_applicable', undefined, signal?.aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)).slice(0, 300));
    }
  }

  /** @param {import('../../services/contextual_ai_provider.js').ContextualEvidenceEngine} engine
   *  @param {string} purpose
   *  @param {import('../../services/contextual_ai_provider.js').ContextualArticle} article
   *  @param {AbortSignal} [signal]
   *  @returns {Promise<import('../../services/contextual_ai_provider.js').ContextualResult<'related_passages'>>} */
  async function relatedPassages(engine, purpose, article, signal) {
    const source = sourceFor(article);
    try {
      if (engine === 'local-ai') {
        /** @type {{rows: Array<Record<string, unknown>>}} */
        const proposed = await root.localAi.proposePassages(purpose, article.paragraphs, { signal: signal });
        const response = await apiClient.post('/api/reader/passages', {
          purpose, article, proposed: proposed.rows.map(row => ({ ...row, source: 'S1' })),
        }, { signal: signal });
        return result('related_passages', 'ok', 'chrome_local', source, 'exact_source_checked', response);
      }
      if (engine === 'server-ai' || engine === 'mock') {
        const response = await apiClient.post('/api/reader/evidence', { purpose, article }, { signal: signal });
        return result('related_passages', 'ok', response.method === 'mock' ? 'mock' : 'configured_server', source, 'exact_source_checked', response);
      }
      const response = await apiClient.post('/api/reader/passages', { purpose, article }, { signal: signal });
      return result('related_passages', 'ok', 'rules', source, 'exact_source_checked', response);
    } catch (error) {
      /** @type {import('../../services/contextual_ai_provider.js').ContextualProcessor} */
      const processor = engine === 'server-ai' ? 'configured_server' : engine === 'mock' ? 'mock' : engine === 'local-ai' ? 'chrome_local' : 'rules';
      return result('related_passages', signal?.aborted ? 'cancelled' : 'error', processor, source, 'not_applicable', undefined, signal?.aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)).slice(0, 300));
    }
  }

  /** @param {import('../../services/contextual_ai_provider.js').ContextualEvidenceEngine} engine
   *  @param {string} purpose
   *  @param {import('../../services/contextual_ai_provider.js').ContextualArticle} article
   *  @param {AbortSignal} [signal]
   *  @returns {Promise<import('../../services/contextual_ai_provider.js').ContextualResult<'article_summary'>>} */
  async function articleSummary(engine, purpose, article, signal) {
    const evidence = await relatedPassages(engine, purpose, article, signal);
    if (evidence.status !== 'ok') return result('article_summary', evidence.status, evidence.processor, evidence.source, 'not_applicable', undefined, evidence.failureReason);
    const rows = Array.isArray(evidence.output?.rows) ? evidence.output.rows : [];
    return result('article_summary', 'ok', evidence.processor, evidence.source, evidence.verification, {
      summary: rows.map(row => row.claim).filter(Boolean).join('\n'),
      citations: rows.map(row => ({ quote: row.quote, paragraphIndex: row.paragraphIndex })),
      rows,
      rejected: evidence.output?.rejected || [],
    });
  }

  /** @param {string} paragraph
   *  @param {number} paragraphIndex
   *  @param {import('../../services/contextual_ai_provider.js').ContextualArticle} article
   *  @param {AbortSignal} [signal]
   *  @returns {Promise<import('../../services/contextual_ai_provider.js').ContextualResult<'typed_tool_proposal'>>} */
  async function proposeTool(paragraph, paragraphIndex, article, signal) {
    const source = sourceFor(article, [paragraphIndex]);
    try {
      if (signal?.aborted) return result('typed_tool_proposal', 'cancelled', 'chrome_local', source, 'not_applicable', undefined, 'cancelled');
      if (typeof root.localAi === 'undefined' || typeof root.localAi.proposeReaderCalculator !== 'function'
        || (await root.localAi.availability('prompt')) === 'unavailable') {
        return result('typed_tool_proposal', 'unavailable', 'chrome_local', source, 'not_applicable', undefined, 'chrome_prompt_unavailable');
      }
      const proposal = await root.localAi.proposeReaderCalculator(paragraph, { signal: signal });
      return result('typed_tool_proposal', proposal ? 'ok' : 'error', 'chrome_local', source, 'unverified_generation', { supported: Boolean(proposal?.supported), proposal }, proposal ? undefined : 'invalid_model_output');
    } catch (error) {
      return result('typed_tool_proposal', signal?.aborted ? 'cancelled' : 'error', 'chrome_local', source, 'not_applicable', undefined, signal?.aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)).slice(0, 300));
    }
  }

  /** @template {import('../../services/contextual_ai_provider.js').ContextualCapability} C
   *  @param {C} capability
   *  @param {import('../../services/contextual_ai_provider.js').ContextualSource} source
   *  @param {(options:{signal?:AbortSignal})=>Promise<import('../../services/contextual_ai_provider.js').ContextualOutputByCapability[C]>} generate
   *  @param {AbortSignal} [signal]
   *  @returns {Promise<import('../../services/contextual_ai_provider.js').ContextualResult<C>>} */
  async function runLocalWritingCapability(capability, source, generate, signal) {
    if (signal?.aborted) return result(capability, 'cancelled', 'chrome_local', source, 'not_applicable', undefined, 'cancelled');
    try {
      if (typeof root.localAi === 'undefined' || (await root.localAi.availability('prompt')) === 'unavailable') {
        return result(capability, 'unavailable', 'chrome_local', source, 'not_applicable', undefined, 'chrome_prompt_unavailable');
      }
      const output = await generate({ signal: signal });
      if (signal?.aborted) return result(capability, 'cancelled', 'chrome_local', source, 'not_applicable', undefined, 'cancelled');
      return result(capability, 'ok', 'chrome_local', source, 'unverified_generation', output);
    } catch (error) {
      return result(capability, signal?.aborted ? 'cancelled' : 'error', 'chrome_local', source, 'not_applicable', undefined, signal?.aborted ? 'cancelled' : (error instanceof Error ? error.message : String(error)).slice(0, 300));
    }
  }

  /** @param {string} title @param {string} purpose @param {Array<{id:string,sourceTitle:string,quote:string,verification:string}>} citations @param {AbortSignal} [signal] */
  async function proposeOutline(title, purpose, citations, signal) {
    const source = { id: 'document-outline', version: String(Date.now()) };
    return runLocalWritingCapability('outline_proposal', source, async options => ({
      markdown: await root.localAi.draftCitationOutline(title, purpose, citations, options),
    }), signal);
  }

  /** @param {string} purpose @param {Array<{id:string,title:string,citations:Array<{citationId:string,quote:string,verification:string}>}>} sources @param {AbortSignal} [signal] */
  async function compareSources(purpose, sources, signal) {
    const source = { id: sources.map(row => row.id).join(','), version: String(Date.now()) };
    return runLocalWritingCapability('cross_source_comparison', source, async options => ({
      markdown: await root.localAi.compareVerifiedSources(purpose, sources.map(row => ({ title: row.title, citations: row.citations.map(citation => ({ quote: citation.quote, verification: citation.verification })) })), options),
    }), signal);
  }

  /** @param {string} claim @param {Array<{citationId:string,sourceTitle:string,quote:string}>} citations @param {AbortSignal} [signal] */
  async function reviewClaim(claim, citations, signal) {
    const source = { id: 'document-claim', version: String(Date.now()) };
    return runLocalWritingCapability('claim_evidence_review', source, async options => ({
      review: await root.localAi.reviewClaimEvidence(claim, citations, options),
    }), signal);
  }

  /** @param {string} selection @param {string} purpose @param {Array<{sourceTitle:string,quote:string}>} citations @param {AbortSignal} [signal] */
  async function rewriteSelection(selection, purpose, citations, signal) {
    const source = { id: 'document-selection', version: String(Date.now()) };
    return runLocalWritingCapability('rewrite_selection', source, async options => ({
      rewrite: await root.localAi.rewriteSelection(selection, purpose, citations, options),
    }), signal);
  }

  /** @type {import('../../services/contextual_ai_provider.js').ContextualAiClient} */
  const client = Object.freeze({ queryTerms, relatedPassages, articleSummary, proposeTool, proposeOutline, compareSources, reviewClaim, rewriteSelection, sourceFor });
  root.contextualAi = client;
})(/** @type {any} */ (typeof window !== 'undefined' ? window : globalThis));
