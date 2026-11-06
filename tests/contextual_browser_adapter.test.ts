import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { ContextualAiClient, ContextualArticle } from '../services/contextual_ai_provider.js';

function loadBrowserClient(options: {
  ai?: { availability: (kind: string) => Promise<string>; expandKeywords?: (keywords: string[], options?: { signal?: AbortSignal }) => Promise<string[]>; proposeReaderCalculator?: (paragraph: string, options?: { signal?: AbortSignal }) => Promise<unknown>; proposePassages?: (purpose: string, paragraphs: string[], options?: { signal?: AbortSignal }) => Promise<{ rows: Array<Record<string, unknown>> }> };
  featureState?: { ai?: boolean; aiMode?: string };
  post?: (route: string, payload: unknown, options?: { signal?: AbortSignal }) => Promise<any>;
} = {}) {
  const calls: Array<{ route: string; payload: unknown; signal?: AbortSignal }> = [];
  const sandbox: Record<string, any> = {
    mySearchContextualApi: {
      post: async (route: string, payload: unknown, opts?: { signal?: AbortSignal }) => {
        calls.push({ route, payload, signal: opts?.signal });
        return options.post ? options.post(route, payload, opts) : {};
      },
    },
    getMySearchContextualFeatures: () => options.featureState,
    localAi: options.ai,
    AbortSignal,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/contextual_ai_provider.js'), 'utf8'), sandbox);
  return { client: sandbox.contextualAi as ContextualAiClient, calls };
}

const article: ContextualArticle = {
  id: 'saved-card-7', url: 'https://example.test/article', title: '保存記事',
  toolsSourceHash: 'sha256:article-v2', paragraphs: ['原文の根拠となる段落です。'],
};

describe('browser contextual AI adapter contract', () => {
  it('returns typed provenance for local search-term and tool proposals', async () => {
    const { client } = loadBrowserClient({ ai: {
      availability: async () => 'available',
      expandKeywords: async () => ['関連語'],
      proposeReaderCalculator: async () => ({ supported: true, title: '計算', expression: 'a+b' }),
    } });

    const terms = await client.queryTerms(['検索語']);
    expect(terms).toMatchObject({
      capability: 'search_terms', status: 'ok', processor: 'chrome_local',
      source: { id: 'search-query', version: 'current-input' },
      verification: 'unverified_generation', output: { suggestions: ['関連語'] },
    });
    const tool = await client.proposeTool(article.paragraphs[0], 0, article);
    expect(tool).toMatchObject({
      capability: 'typed_tool_proposal', status: 'ok', processor: 'chrome_local',
      source: { id: 'saved-card-7', version: 'sha256:article-v2', paragraphIndices: [0] },
      verification: 'unverified_generation',
      output: { supported: true, proposal: { expression: 'a+b' } },
    });
  });

  it('uses the rule provider without claiming AI and retains the quote source through summarization', async () => {
    const { client, calls } = loadBrowserClient({
      ai: { availability: async () => 'unavailable' },
      post: async route => ({
        method: 'words', rows: [{ claim: '検索語', quote: '原文の根拠となる段落です。', paragraphIndex: 0 }], rejected: [], chunks: 1,
      }),
    });
    const controller = new AbortController();
    const response = await client.articleSummary('words', '検索語', article, controller.signal);
    expect(response).toMatchObject({
      capability: 'article_summary', status: 'ok', processor: 'rules',
      source: { id: 'saved-card-7', version: 'sha256:article-v2' },
      verification: 'exact_source_checked',
      output: { summary: '検索語', citations: [{ quote: '原文の根拠となる段落です。', paragraphIndex: 0 }] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBe('/api/reader/passages');
    expect(calls[0].signal).toBe(controller.signal);
  });

  it('reports unavailable local AI without invoking another provider', async () => {
    const { client, calls } = loadBrowserClient({ ai: { availability: async () => 'unavailable' } });
    const response = await client.proposeTool(article.paragraphs[0], 0, article);
    expect(response).toMatchObject({
      capability: 'typed_tool_proposal', status: 'unavailable', processor: 'chrome_local',
      failureReason: 'chrome_prompt_unavailable',
      source: { id: 'saved-card-7', version: 'sha256:article-v2' },
    });
    expect(calls).toHaveLength(0);
  });

  it('forwards cancellation to the selected provider and returns a cancelled result', async () => {
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const { client, calls } = loadBrowserClient({ ai: {
      availability: async () => 'available',
      expandKeywords: async (_keywords, options) => {
        receivedSignal = options?.signal;
        markStarted();
        return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    } });
    const controller = new AbortController();
    const pending = client.queryTerms(['検索語'], controller.signal);
    await started;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', failureReason: 'cancelled' });
    expect(receivedSignal).toBe(controller.signal);
    expect(calls).toHaveLength(0);
  });

  it('passes cancellation to configured server adapters', async () => {
    const { client, calls } = loadBrowserClient({ featureState: { ai: true, aiMode: 'configured' } });
    const controller = new AbortController();
    await client.queryTerms(['検索語'], controller.signal);
    expect(calls[0]?.route).toBe('/api/search/expand-keywords');
    expect(calls[0]?.signal).toBe(controller.signal);
  });
});
