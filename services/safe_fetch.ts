/**
 * Fetching pages of sites the user registered, from the server, safely.
 *
 * - Only http/https, no user:password@, only the usual ports.
 * - The host name is resolved and EVERY address is checked: loopback, private, link-local,
 *   carrier-grade NAT, multicast, documentation and other special ranges are refused.
 * - The check runs inside the connection's own DNS lookup, so the address that is checked is
 *   the address that is connected to (a second, different DNS answer cannot slip through).
 * - Redirects are followed by hand and every hop is checked again.
 * - Timeout for the whole request, a size limit on the body, gzip/deflate/br decoded with the
 *   same limit, at most one request at a time per host with a pause between requests, and a
 *   retry with back-off for 429/503 and network errors.
 * - The body is returned as text/bytes only: nothing in it is executed.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export const SAFE_FETCH_USER_AGENT = 'my-search/1.0 (personal reading tool; +https://github.com/jinghaodao-tech/my-search_public)';

export class SafeFetchError extends Error {
  constructor(message: string, readonly code: 'invalid_url' | 'blocked' | 'timeout' | 'too_large' | 'http' | 'network' | 'redirects', readonly status = 0) {
    super(message);
  }
}

// ─── addresses ───────────────────────────────────────────────

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2002::', 16],
] as const) BLOCKED.addSubnet(address, prefix, 'ipv6');

/** true for an address on the public internet. IPv4-mapped IPv6 is checked as IPv4. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(address)) return false;
    return !BLOCKED.check(address, 'ipv6');
  }
  return false;
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|home\.arpa|localdomain)$/i;

/** Syntax check of a URL that may be fetched (the address check happens when connecting). */
export function assertPublicUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new SafeFetchError('URLの形式が正しくありません', 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchError('http または https のURLだけ使えます', 'invalid_url');
  if (url.username || url.password) throw new SafeFetchError('ユーザー名・パスワード付きのURLは使えません', 'invalid_url');
  if (!ALLOWED_PORTS.has(url.port)) throw new SafeFetchError('このポート番号のURLは使えません', 'blocked');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_NAMES.test(host)) throw new SafeFetchError('ローカル・社内向けのアドレスには接続しません', 'blocked');
  if (net.isIP(host) && !isPublicAddress(host)) throw new SafeFetchError('ローカル・プライベートなアドレスには接続しません', 'blocked');
  if (!net.isIP(host) && !host.includes('.')) throw new SafeFetchError('ドメイン名が正しくありません', 'invalid_url');
  return url;
}

export type AddressPolicy = (address: string) => boolean;

/** dns.lookup that refuses the whole host if any of its addresses is not allowed. */
function guardedLookup(isAllowed: AddressPolicy) {
  return (hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) { callback(err, '', 0); return; }
      const list = addresses as dns.LookupAddress[];
      if (!list.length || list.some(entry => !isAllowed(entry.address))) {
        callback(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }), '', 0);
        return;
      }
      if (options && (options as { all?: boolean }).all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

// ─── per-host pacing ─────────────────────────────────────────

const hostQueues = new Map<string, Promise<unknown>>();
const hostLastAt = new Map<string, number>();

async function paced<T>(host: string, intervalMs: number, task: () => Promise<T>): Promise<T> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const wait = (hostLastAt.get(host) ?? 0) + intervalMs - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    try {
      return await task();
    } finally {
      hostLastAt.set(host, Date.now());
    }
  });
  hostQueues.set(host, run);
  try {
    return await run;
  } finally {
    if (hostQueues.get(host) === run) hostQueues.delete(host);
  }
}

// ─── one request ─────────────────────────────────────────────

export type SafeResponse = { url: string; status: number; contentType: string; headers: Record<string, string | string[] | undefined>; bytes: Buffer; text: () => string };

type RequestOptions = { maxBytes: number; timeoutMs: number; headers: Record<string, string>; isAllowed: AddressPolicy; allowedContentTypes?: RegExp; contentTypeLimits?: Array<{pattern: RegExp; maxBytes: number}> };

function requestOnce(url: URL, options: RequestOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      headers: { 'user-agent': SAFE_FETCH_USER_AGENT, 'accept-encoding': 'gzip, deflate, br', ...options.headers },
      lookup: guardedLookup(options.isAllowed) as unknown as net.LookupFunction,
      timeout: options.timeoutMs,
    });
    const timer = setTimeout(() => req.destroy(new SafeFetchError('時間内に応答がありませんでした', 'timeout')), options.timeoutMs);
    req.on('timeout', () => req.destroy(new SafeFetchError('時間内に応答がありませんでした', 'timeout')));
    req.on('error', error => {
      clearTimeout(timer);
      if (error instanceof SafeFetchError) reject(error);
      else if ((error as NodeJS.ErrnoException).code === 'EBLOCKED') reject(new SafeFetchError('ローカル・プライベートなアドレスには接続しません', 'blocked'));
      else reject(new SafeFetchError(`接続できませんでした（${(error as NodeJS.ErrnoException).code ?? error.message}）`, 'network'));
    });
    req.on('response', res => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { // redirects, and 304 Not Modified (no body)
        res.destroy();
        clearTimeout(timer);
        resolve({ status, headers: res.headers, bytes: Buffer.alloc(0) });
        return;
      }
      const declared = Number(res.headers['content-length'] ?? 0);
      const type = String(res.headers['content-type'] ?? '');
      if (status >= 200 && status < 300 && options.allowedContentTypes && !options.allowedContentTypes.test(type)) {
        reject(new SafeFetchError('対応していない種類のファイルです（Content-Type）', 'http', 415));
        res.destroy(); clearTimeout(timer); return;
      }
      const limit = Math.min(options.maxBytes, options.contentTypeLimits?.find(item => item.pattern.test(type))?.maxBytes ?? options.maxBytes);
      if (declared > limit) {
        reject(new SafeFetchError('ページが大きすぎます', 'too_large'));
        res.destroy();
        clearTimeout(timer);
        return;
      }
      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream = encoding === 'gzip' || encoding === 'x-gzip' ? res.pipe(zlib.createGunzip())
        : encoding === 'deflate' ? res.pipe(zlib.createInflate())
        : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : res;
      let wireBytes = 0;
      res.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length;
        if (wireBytes > options.maxBytes) {
          reject(new SafeFetchError('ページが大きすぎます', 'too_large'));
          clearTimeout(timer); stream.destroy(); res.destroy();
        }
      });
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(new SafeFetchError('ページが大きすぎます', 'too_large'));
          stream.destroy();
          res.destroy();
          clearTimeout(timer);
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => { clearTimeout(timer); resolve({ status, headers: res.headers, bytes: Buffer.concat(chunks) }); });
      stream.on('error', error => { clearTimeout(timer); reject(new SafeFetchError(`応答を読めませんでした（${error.message}）`, 'network')); res.destroy(); });
      res.on('aborted', () => { clearTimeout(timer); stream.destroy(); reject(new SafeFetchError('応答が途中で切れました', 'network')); });
      res.on('error', error => { clearTimeout(timer); stream.destroy(); reject(new SafeFetchError(error.message, 'network')); });
    });
    req.end();
  });
}

function decodeText(bytes: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  const head = bytes.subarray(0, 2048).toString('latin1');
  const declared = charset ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase() ?? head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(declared && declared !== 'utf8' ? declared : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ─── fetcher ─────────────────────────────────────────────────

export type SafeFetchOptions = {
  validateUrl?: (url: URL) => void;
  allowedContentTypes?: RegExp;
  contentTypeLimits?: Array<{pattern: RegExp; maxBytes: number}>;
  maxBytes?: number;
  timeoutMs?: number;
  accept?: string;
  maxRedirects?: number;
  retries?: number;
  /** pause between two requests to the same host */
  hostIntervalMs?: number;
  /** conditional request: unchanged pages answer 304 without a body */
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
};

export type SafeFetcher = (url: string | URL, options?: SafeFetchOptions) => Promise<SafeResponse>;

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new SafeFetchError('時間内に応答がありませんでした', 'timeout')), Math.max(0, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** isAllowed decides which IP addresses may be connected to (tests allow 127.0.0.1 on purpose). */
export function createSafeFetcher(policy: { isAllowed?: AddressPolicy; checkUrl?: (url: string | URL) => URL } = {}): SafeFetcher {
  const isAllowed = policy.isAllowed ?? isPublicAddress;
  const checkUrl = policy.checkUrl ?? assertPublicUrl;
  return async (raw, options = {}) => {
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    const retryDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, Math.min(ms, deadline - Date.now()))));
    const maxRedirects = options.maxRedirects ?? 5;
    const retries = options.retries ?? 1;
    const hostIntervalMs = options.hostIntervalMs ?? 1000;
    let url = checkUrl(raw);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      options.validateUrl?.(url);
      let attempt = 0;
      let result: Awaited<ReturnType<typeof requestOnce>>;
      for (;;) {
        try {
          const headers: Record<string, string> = {};
          if (options.accept) headers.accept = options.accept;
          if (options.ifNoneMatch) headers['if-none-match'] = options.ifNoneMatch;
          if (options.ifModifiedSince) headers['if-modified-since'] = options.ifModifiedSince;
          result = await beforeDeadline(paced(url.host, hostIntervalMs, () => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new SafeFetchError('時間内に応答がありませんでした', 'timeout');
            return requestOnce(url, { maxBytes, timeoutMs: remaining, isAllowed, headers, allowedContentTypes: options.allowedContentTypes, contentTypeLimits: options.contentTypeLimits });
          }), deadline);
          if ((result.status === 429 || result.status === 503) && attempt < retries) {
            const retryAfter = Number(result.headers['retry-after']);
            await retryDelay(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt, 10_000));
            attempt += 1;
            continue;
          }
          break;
        } catch (error) {
          if (error instanceof SafeFetchError && error.code === 'network' && attempt < retries) {
            await retryDelay(1000 * 2 ** attempt);
            attempt += 1;
            continue;
          }
          throw error;
        }
      }
      if (result.status === 304) {
        const bytes = Buffer.alloc(0);
        return { url: url.toString(), status: 304, contentType: '', headers: result.headers, bytes, text: () => '' };
      }
      if (result.status >= 300 && result.status < 400) {
        const location = result.headers.location;
        if (!location) throw new SafeFetchError(`リダイレクト先がありません（HTTP ${result.status}）`, 'http', result.status);
        url = checkUrl(new URL(location, url));
        continue;
      }
      const contentType = String(result.headers['content-type'] ?? '');
      const bytes = result.bytes;
      const response: SafeResponse = { url: url.toString(), status: result.status, contentType, headers: result.headers, bytes, text: () => decodeText(bytes, contentType) };
      if (result.status < 200 || result.status >= 400) throw Object.assign(new SafeFetchError(`HTTP ${result.status}`, 'http', result.status), { response });
      return response;
    }
    throw new SafeFetchError('リダイレクトが多すぎます', 'redirects');
  };
}

export const safeFetch = createSafeFetcher();
