import { JSDOM } from 'jsdom';

export type RssTextItem = {
  'content:encoded'?: string | null;
  content?: string | null;
  contentSnippet?: string | null;
  summary?: string | null;
};

export type SelectedRssContent = {
  body: string;
  summary: string;
  bodyKind: 'fulltext' | 'excerpt';
};

export const RSS_INDEX_BODY_MAX_CHARS = 100_000;
const RSS_SUMMARY_MAX_CHARS = 1_000;

function plainText(raw: string | null | undefined): string {
  if (!raw?.trim()) return '';
  // An inert fragment decodes entities without executing scripts or loading resources.
  const fragment = JSDOM.fragment(raw);
  fragment.querySelectorAll('script,style,template,noscript').forEach(node => node.remove());
  fragment.querySelectorAll('br,hr,p,div,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr,td,th,dt,dd,section,article')
    .forEach(node => { node.before(' '); node.after(' '); });
  return (fragment.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function firstText(values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = plainText(value);
    if (text) return text;
  }
  return '';
}

/** "fulltext" identifies an untruncated feed payload, not a guarantee about the original page. */
export function selectRssContent(item: RssTextItem): SelectedRssContent {
  const encoded = plainText(item['content:encoded']);
  const content = encoded || firstText([item.content, item.summary, item.contentSnippet]);
  const body = content.slice(0, RSS_INDEX_BODY_MAX_CHARS);
  const summary = firstText([item.summary, item.content, item.contentSnippet]) || body;
  return {
    body,
    summary: summary.slice(0, RSS_SUMMARY_MAX_CHARS),
    bodyKind: encoded && encoded.length <= RSS_INDEX_BODY_MAX_CHARS ? 'fulltext' : 'excerpt',
  };
}
