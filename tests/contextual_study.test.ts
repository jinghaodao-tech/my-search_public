import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadStudy(consent = false) {
  const store = new Map<string, string>(consent ? [['mySearch:contextualStudy:consent:v1', 'true']] : []);
  const sandbox: Record<string, any> = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
    ContextualAutomation: { read: () => ({ f1: true, f2: true, f3: true, f4: true, f5: false, f6: true }) },
    document: { addEventListener() {}, getElementById() { return null; } },
    setTimeout: () => 1,
    clearTimeout() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/contextual_study.js'), 'utf8'), sandbox);
  return { study: sandbox.ContextualStudy, store };
}

describe('consent-gated local contextual study instrumentation', () => {
  it('stores nothing before explicit consent', () => {
    const { study, store } = loadStudy();
    expect(study.record({ feature: 'f1', event: 'shown', trigger: 'snippet_match' })).toBe(false);
    expect(store.size).toBe(0);
  });

  it('records only allowlisted metadata, captures settings, and supports deletion/revocation', () => {
    const { study, store } = loadStudy(true);
    expect(study.record({ feature: 'f6', event: 'completed', mode: 'manual', trigger: 'search_result', processor: 'mock', outcome: 'ok', latencyMs: 123.6,
      query: '秘密の検索文', articleId: 'private-card-id', body: '本文' })).toBe(true);
    const [event] = study.readEvents();
    expect(event).toMatchObject({
      schema: 'my-search-contextual-study-v1', featureVersion: 'contextual-f6-v1',
      feature: 'f6', event: 'completed', mode: 'manual', trigger: 'search_result',
      processor: 'mock', outcome: 'ok', latencyMs: 124, enabled: true,
    });
    expect(JSON.stringify(event)).not.toContain('秘密の検索文');
    expect(JSON.stringify(event)).not.toContain('private-card-id');
    expect(JSON.stringify(event)).not.toContain('本文');
    expect(study.setConsent(false)).toBe(true);
    expect(study.record({ feature: 'f2', event: 'shown' })).toBe(false);
    expect(study.clearEvents()).toBe(true);
    expect(store.has('mySearch:contextualStudy:events:v1')).toBe(false);
  });
});
