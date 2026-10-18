import { createHash } from 'node:crypto';

/** Strip only non-content tracking data; keep protocol, path and meaningful query values. */
export function canonicalArticleUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return raw;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch { return raw; }
}

export function stableArticleId(kind: string, identifier: string): string {
  return `${kind}_${createHash('sha256').update(identifier).digest('hex').slice(0, 32)}`;
}

/** Preserve the site's historical identity aliases without changing a URL used for HTTP. */
export function articleIdentityKey(raw: string): string {
  try {
  const url = new URL(canonicalArticleUrl(raw));
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  return `${url.hostname.replace(/^www\./, '')}${url.port ? `:${url.port}` : ''}${path}${url.search}`;
  } catch { return raw; }
}
