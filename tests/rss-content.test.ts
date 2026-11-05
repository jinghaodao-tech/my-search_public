import RSSParser from 'rss-parser';
import { describe, expect, it } from 'vitest';
import { RSS_INDEX_BODY_MAX_CHARS, selectRssContent } from '../services/rss_content.js';

const needle = 'CVE-2026-92392';

describe('syndicated RSS body selection', () => {
  it('retains a keyword after the old cutoff in content:encoded independently of the summary', async () => {
    const first = `<item><title>First</title><description>About ${needle}</description></item>`;
    const second = `<item><title>Second</title><description>Short update</description><content:encoded><![CDATA[<p>${'Background. '.repeat(150)} ${needle}</p>]]></content:encoded></item>`;
    const others = Array.from({ length: 8 }, (_, n) => `<item><title>Other ${n}</title><description>Unrelated</description></item>`).join('');
    const feed = await new RSSParser().parseString(`<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Regression</title>${first}${second}${others}</channel></rss>`);
    const selected = feed.items.map(selectRssContent);
    expect(selected).toHaveLength(10);
    expect(selected.filter(item => item.body.includes(needle))).toHaveLength(2);
    expect(selected[1].body.length).toBeGreaterThan(1200);
    expect(selected[1].summary).toBe('Short update');
    expect(selected[1].bodyKind).toBe('fulltext');
    expect(selected[0].bodyKind).toBe('excerpt');
  });

  it('falls back to description without claiming it is a full copy', () => {
    expect(selectRssContent({ content: '<p>Description</p>', contentSnippet: 'Description' }))
      .toEqual({ body: 'Description', summary: 'Description', bodyKind: 'excerpt' });
  });

  it('uses the first nonempty usable value, including after removal of script-only content', () => {
    expect(selectRssContent({ 'content:encoded': '<script>invalid</script>', content: '', summary: '<p>Fallback</p>' }))
      .toEqual({ body: 'Fallback', summary: 'Fallback', bodyKind: 'excerpt' });
    expect(selectRssContent({})).toEqual({ body: '', summary: '', bodyKind: 'excerpt' });
  });

  it('keeps an explicit Atom summary separate from a long content field', () => {
    const selected = selectRssContent({ content: '<p>Long body</p>', contentSnippet: 'Long body', summary: 'Brief summary' });
    expect(selected).toEqual({ body: 'Long body', summary: 'Brief summary', bodyKind: 'excerpt' });
  });

  it('decodes entities, separates blocks, and drops executable/style/template contents', () => {
    const selected = selectRssContent({ 'content:encoded': '<script>BAD_SCRIPT</script><style>BAD_STYLE</style><template>BAD_TEMPLATE</template><!-- BAD_COMMENT --><p>A &copy; &#x1f680;</p><p>B&nbsp;C<br>D</p>' });
    expect(selected.body).toBe('A \u00a9 \u{1f680} B C D');
    expect(selected.body).not.toContain('BAD_');
    expect(selectRssContent({ content: '<script>Hidden</script><p>Visible</p>', contentSnippet: 'Hidden Visible' }).summary).toBe('Visible');
  });

  it('preserves escaped code as text rather than stripping it as markup', () => {
    const selected = selectRssContent({ 'content:encoded': '<pre>&lt;script&gt;example&lt;/script&gt; &lt;T&gt; a &lt; b</pre>' });
    expect(selected.body).toBe('<script>example</script> <T> a < b');
  });

  it('bounds the indexed body and never marks a truncated copy fulltext', () => {
    const selected = selectRssContent({ 'content:encoded': `<p>${'x'.repeat(RSS_INDEX_BODY_MAX_CHARS + 300)}</p>` });
    expect(selected.body).toHaveLength(RSS_INDEX_BODY_MAX_CHARS);
    expect(selected.summary).toHaveLength(1000);
    expect(selected.bodyKind).toBe('excerpt');
  });

  it('checks the decoded text limit, not the length of surrounding HTML', () => {
    const selected = selectRssContent({ 'content:encoded': `<p data-padding="${'x'.repeat(RSS_INDEX_BODY_MAX_CHARS)}">Complete text</p>` });
    expect(selected.body).toBe('Complete text');
    expect(selected.bodyKind).toBe('fulltext');
    expect(selectRssContent({ 'content:encoded': 'x'.repeat(RSS_INDEX_BODY_MAX_CHARS) }).bodyKind).toBe('fulltext');
  });

  it('bounds description-only content too', () => {
    const selected = selectRssContent({ content: 'x'.repeat(RSS_INDEX_BODY_MAX_CHARS + 10) });
    expect(selected.body).toHaveLength(RSS_INDEX_BODY_MAX_CHARS);
    expect(selected.bodyKind).toBe('excerpt');
  });
});
