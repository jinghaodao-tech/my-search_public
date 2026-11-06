import { describe, expect, it } from 'vitest';
import { createContextualAdapter, type ContextualRequest } from '../services/contextual_ai_provider.js';

const request: ContextualRequest<'typed_tool_proposal'> = {
  capability: 'typed_tool_proposal',
  source: { id: 'reader:one', version: 'sha256:test', paragraphIndices: [2] },
  input: { paragraph: '12円から20円、初期値16円', paragraphIndex: 2 },
};

describe('contextual AI provider contract', () => {
  it('carries capability, processor, source version, and validation state in the result', async () => {
    const provider = createContextualAdapter('typed_tool_proposal', {
      processor: 'chrome_local',
      modelVersion: null,
      execute: async input => ({
        output: { supported: true, proposal: { title: '試算' } },
        verification: input.source.version === 'sha256:test' ? 'unverified_generation' : 'rejected',
      }),
    });
    const result = await provider.execute(request);
    expect(provider.supports('typed_tool_proposal')).toBe(true);
    expect(provider.supports('article_summary')).toBe(false);
    expect(result).toMatchObject({
      capability: 'typed_tool_proposal', status: 'ok', processor: 'chrome_local',
      source: request.source, verification: 'unverified_generation',
    });
  });

  it('reports unavailable, cancelled, and provider errors without losing the source identity', async () => {
    const unavailable = createContextualAdapter('related_passages', {
      processor: 'configured_server',
      available: async () => ({ available: false, reason: 'no_provider_key' }),
      execute: async () => ({ output: { rows: [] }, verification: 'exact_source_checked' }),
    });
    expect(await unavailable.execute({
      capability: 'related_passages', source: { id: 'article', version: 'v1' },
      input: { purpose: '目的', paragraphs: ['本文'] },
    })).toMatchObject({ status: 'unavailable', failureReason: 'no_provider_key', source: { id: 'article', version: 'v1' } });

    const controller = new AbortController(); controller.abort();
    expect(await unavailable.execute({
      capability: 'related_passages', source: { id: 'article', version: 'v1' },
      input: { purpose: '目的', paragraphs: ['本文'] },
    }, controller.signal)).toMatchObject({ status: 'cancelled', source: { id: 'article', version: 'v1' } });

    const failing = createContextualAdapter('related_passages', {
      processor: 'configured_server',
      execute: async () => { throw new Error('provider timeout'); },
    });
    expect(await failing.execute({
      capability: 'related_passages', source: { id: 'article', version: 'v1' },
      input: { purpose: '目的', paragraphs: ['本文'] },
    })).toMatchObject({ status: 'error', failureReason: 'provider timeout', verification: 'not_applicable' });
  });
});
