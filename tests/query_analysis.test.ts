import { describe, expect, it } from 'vitest';
import './helpers.js';
import { analyzeQuery, detectIntent } from '../services/query_analysis.js';
import { purposeWords } from '../services/discover_service.js';
import { tokenizeQuery } from '../bm25_engine.js';

const analyze = async (text: string) => analyzeQuery(text, await purposeWords(text));

describe('broad questions and generic words', () => {
  it('a question without a topic word is broad; generic words count for little', async () => {
    const it1 = await analyze('IT業界での現在問題になっていること');
    expect(it1.broad).toBe(true);
    expect(it1.intent).toBe('trend');
    expect(it1.keywords.find(k => k.term === '問題')?.weight).toBeLessThan(1);
    const it2 = await analyze('現代のプログラマーが勉強すべきこと');
    expect(it2).toMatchObject({ broad: true, intent: 'learn' });
  });

  it('specific questions are not broad, and short capitalised names are kept', async () => {
    expect((await analyze('Istio OperatorからHelmへの移行')).broad).toBe(false);
    expect((await analyze('過熱商品の負荷軽減')).broad).toBe(false);
    const rustGo = await analyze('RustとGoの比較');
    expect(rustGo.broad).toBe(false);
    expect(rustGo.keywords.map(k => k.term)).toContain('go');
  });

  it('katakana words written together are searched as one word', async () => {
    expect((await analyze('ページラッチ')).keywords.map(k => k.term)).toEqual(['ページラッチ']);
  });

  it('kinds of questions', () => {
    expect(detectIntent('Kubernetesとは')).toBe('overview');
    expect(detectIntent('なぜDBが遅くなるのか')).toBe('why');
    expect(detectIntent('他社の導入事例')).toBe('case');
    expect(detectIntent('前に読んだWALの記事')).toBe('mine');
  });

  it('a long katakana query word is not split into 2-character pieces', async () => {
    const tokens = await tokenizeQuery('プログラマー');
    expect(tokens).toContain('プログラマー');
    expect(tokens).not.toContain('プロ');
    expect(await tokenizeQuery('データ')).toContain('デー'); // short words keep their pieces (データベース)
  });
});
