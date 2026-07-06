import { errorMeta, logger } from '../utils/logger.js';
import type { Card } from '../domain/card.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL =
  process.env.ANTHROPIC_MODEL ??
  'claude-haiku-4-5-20251001';
export const AI_PROVIDER = (process.env.AI_PROVIDER ?? 'anthropic').trim().toLowerCase();
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
const MOCK_AI_SUMMARY = process.env.MOCK_AI_SUMMARY?.trim().toLowerCase() === 'true';
const AI_DEBUG = process.env.NODE_ENV !== 'production';

type SearchMatchField = 'title' | 'body' | 'summary' | 'tags';

function normalizeSearchText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase();
}

function buildSearchKeywordCandidates(config: unknown): string[] {
  const keywords = (config as { keywords?: Array<{ term?: unknown; synonyms?: unknown[] }> })?.keywords ?? [];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const keyword of keywords) {
    const text = String(keyword.term ?? '').trim();
    const key = normalizeSearchText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    candidates.push(text);
  }

  return candidates;
}

function buildSearchMatchMeta(
  article: { title?: unknown; body?: unknown; summary?: unknown; tags?: unknown },
  keywords: string[],
  matchedTerms: Array<{ term?: unknown }> = [],
): { matchedFields: SearchMatchField[]; matchedKeywords: string[] } {
  const fieldTexts: Record<SearchMatchField, string> = {
    title: normalizeSearchText(article.title),
    body: normalizeSearchText(article.body),
    summary: normalizeSearchText(article.summary),
    tags: Array.isArray(article.tags)
      ? normalizeSearchText(article.tags.join(' '))
      : normalizeSearchText(article.tags),
  };

  const matchedFields = (Object.entries(fieldTexts) as Array<[SearchMatchField, string]>)
    .filter(([, value]) => keywords.some((keyword) => value.includes(normalizeSearchText(keyword))))
    .map(([field]) => field);

  const matchedKeywords = keywords.filter((keyword) => {
    const normalized = normalizeSearchText(keyword);
    return Object.values(fieldTexts).some((value) => value.includes(normalized));
  });

  if (matchedKeywords.length) {
    return { matchedFields, matchedKeywords };
  }

  const fallbackKeywords = [...new Set(matchedTerms.map((term) => String(term.term ?? '').trim()).filter(Boolean))];
  return { matchedFields, matchedKeywords: fallbackKeywords };
}

type AiSummaryErrorCode =
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'timeout'
  | 'empty_summary'
  | 'api_error';

export class AiSummaryError extends Error {
  status: number;
  code: AiSummaryErrorCode;
  details?: string;

  constructor(status: number, code: AiSummaryErrorCode, message: string, details?: string) {
    super(message);
    this.name = 'AiSummaryError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function getAnthropicApiKey(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function getGeminiApiKey(): string | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  return apiKey ? apiKey : null;
}

function logMissingApiKey() {
  logger.error({ event: 'ai_missing_api_key', provider: 'anthropic' }, '[AI SUMMARY] ANTHROPIC_API_KEY is not configured');
}

function buildMissingApiKeyResponse() {
  return {
    error: '\u0041\u004e\u0054\u0048\u0052\u004f\u0050\u0049\u0043_\u0041\u0050\u0049_\u004b\u0045\u0059 \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093',
    code: 'missing_api_key',
  };
}

function mapAnthropicStatus(status: number, body: string): AiSummaryError {
  switch (status) {
    case 401:
      return new AiSummaryError(status, 'invalid_api_key', '\u0041\u0050\u0049\u30ad\u30fc\u304c\u7121\u52b9\u3067\u3059', body);
    case 403:
      return new AiSummaryError(status, 'forbidden', '\u0041\u0050\u0049\u8a8d\u8a3c\u30a8\u30e9\u30fc', body);
    case 404:
      return new AiSummaryError(status, 'model_not_found', '\u30e2\u30c7\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093', body);
    case 429:
      return new AiSummaryError(status, 'rate_limited', '\u30ec\u30fc\u30c8\u5236\u9650\u306b\u9054\u3057\u307e\u3057\u305f', body);
    case 500:
      return new AiSummaryError(status, 'server_error', '\u30b5\u30fc\u30d0\u30fc\u30a8\u30e9\u30fc', body);
    default:
      if (status >= 500) {
        return new AiSummaryError(status, 'server_error', '\u30b5\u30fc\u30d0\u30fc\u30a8\u30e9\u30fc', body);
      }
      return new AiSummaryError(status, 'api_error', '\u0041\u006e\u0074\u0068\u0072\u006f\u0070\u0069\u0063 API\u3067\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f', body);
  }
}

function buildSummaryPayload(card: Card) {
  return {
    model: MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user' as const,
      content:
        `\u4ee5\u4e0b\u306e\u8a18\u4e8b\u3092\u65e5\u672c\u8a9e\u30673\u884c\u4ee5\u5185\u306b\u8981\u7d04\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u6570\u5b57\u3084\u56fa\u6709\u540d\u8a5e\u306f\u7701\u7565\u3057\u306a\u3044\u3067\u304f\u3060\u3055\u3044\u3002\n\n` +
        `\u30bf\u30a4\u30c8\u30eb: ${card.title}\n\u672c\u6587: ${card.body}`,
    }],
  };
}

async function summarizeWithAnthropic(card: Card): Promise<string> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    logMissingApiKey();
    throw new AiSummaryError(500, 'missing_api_key', '\u0041\u004e\u0054\u0048\u0052\u004f\u0050\u0049\u0043_\u0041\u0050\u0049_\u004b\u0045\u0059 \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093');
  }

  const payload = buildSummaryPayload(card);
  if (AI_DEBUG) {
    logger.debug({ event: 'ai_request', provider: 'anthropic', model: MODEL }, '[AI SUMMARY] request prepared');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseBody = await response.text();
    if (AI_DEBUG) {
      logger.debug({
        event: 'ai_response',
        provider: 'anthropic',
        status: response.status,
        statusText: response.statusText,
      }, '[AI SUMMARY] response received');
    }

    if (!response.ok) {
      logger.error({
        event: 'ai_provider_error',
        provider: 'anthropic',
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      }, '[AI SUMMARY] Anthropic error');
      throw mapAnthropicStatus(response.status, responseBody);
    }

    let data: { content?: Array<{ text?: string }> };
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new AiSummaryError(500, 'api_error', '\u0041\u006e\u0074\u0068\u0072\u006f\u0070\u0069\u0063 API\u306e\u30ec\u30b9\u30dd\u30f3\u30b9\u3092\u89e3\u6790\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f', responseBody);
    }

    const summary = data.content?.[0]?.text?.trim() ?? '';
    if (!summary) {
      throw new AiSummaryError(500, 'empty_summary', '\u8981\u7d04\u7d50\u679c\u304c\u7a7a\u3067\u3057\u305f', responseBody);
    }

    return summary;
  } catch (error) {
    if (error instanceof AiSummaryError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiSummaryError(500, 'timeout', '\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u30a8\u30e9\u30fc');
    }
    throw new AiSummaryError(500, 'network_error', '\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u30a8\u30e9\u30fc', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function summarizeWithGemini(card: Card): Promise<string> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    logger.error({ event: 'ai_missing_api_key', provider: 'gemini' }, '[AI SUMMARY] GEMINI_API_KEY is not configured');
    throw new AiSummaryError(500, 'missing_api_key', 'GEMINI_API_KEY is not configured');
  }

  const payload = {
    contents: [{
      parts: [{
        text: buildSummaryPayload(card).messages[0].content,
      }],
    }],
  };
  if (AI_DEBUG) {
    logger.debug({ event: 'ai_request', provider: 'gemini', model: GEMINI_MODEL }, '[AI SUMMARY] Gemini request prepared');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const responseBody = await response.text();

    if (AI_DEBUG) {
      logger.debug({
        event: 'ai_response',
        provider: 'gemini',
        status: response.status,
        statusText: response.statusText,
      }, '[AI SUMMARY] Gemini response received');
    }
    if (!response.ok) {
      logger.error({
        event: 'ai_provider_error',
        provider: 'gemini',
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      }, '[AI SUMMARY] Gemini error');
      throw mapAnthropicStatus(response.status, responseBody);
    }

    let data: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new AiSummaryError(500, 'api_error', 'Invalid Gemini API response', responseBody);
    }

    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    if (!summary) {
      throw new AiSummaryError(500, 'empty_summary', 'Gemini returned an empty summary', responseBody);
    }
    return summary;
  } catch (error) {
    if (error instanceof AiSummaryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiSummaryError(500, 'timeout', 'Gemini API request timed out');
    }
    throw new AiSummaryError(500, 'network_error', 'Gemini API network error', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}


function extractJsonArray(text: string): string[] {
  const trimmed = text.trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/i, '').trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  const raw = match ? match[0] : trimmed;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0 && item.length <= 50)
    .slice(0, 10);
}

function buildKeywordExpansionPrompt(keywords: string[]): string {
  return [
    'Generate search synonyms and related terms for BM25 search.',
    'Return only a JSON array of strings. Do not return explanations.',
    'Keep proper nouns as-is. Mix Japanese and English terms when useful.',
    'Maximum 10 terms. Avoid duplicates and avoid the original input terms.',
    `Input keywords: ${JSON.stringify(keywords)}`,
  ].join('\n');
}

async function expandKeywordsWithAnthropic(keywords: string[]): Promise<string[]> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) throw new AiSummaryError(500, 'missing_api_key', 'ANTHROPIC_API_KEY is not configured');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: buildKeywordExpansionPrompt(keywords) }],
      }),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) throw mapAnthropicStatus(response.status, responseBody);
    const data = JSON.parse(responseBody) as { content?: Array<{ text?: string }> };
    return extractJsonArray(data.content?.[0]?.text ?? '[]');
  } catch (error) {
    if (error instanceof AiSummaryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiSummaryError(500, 'timeout', 'AI keyword expansion timed out');
    throw new AiSummaryError(500, 'api_error', 'AI keyword expansion failed', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function expandKeywordsWithGemini(keywords: string[]): Promise<string[]> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new AiSummaryError(500, 'missing_api_key', 'GEMINI_API_KEY is not configured');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildKeywordExpansionPrompt(keywords) }] }] }),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) throw mapAnthropicStatus(response.status, responseBody);
    const data = JSON.parse(responseBody) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return extractJsonArray(data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]');
  } catch (error) {
    if (error instanceof AiSummaryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AiSummaryError(500, 'timeout', 'AI keyword expansion timed out');
    throw new AiSummaryError(500, 'api_error', 'AI keyword expansion failed', String(error));
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function expandSearchKeywords(keywords: string[]): Promise<string[]> {
  if (MOCK_AI_SUMMARY) {
    return ['implementation', 'development', 'code', 'repository', 'package', 'library', 'debug', 'architecture', 'API', 'module'];
  }
  if (AI_PROVIDER === 'gemini') return expandKeywordsWithGemini(keywords);
  if (AI_PROVIDER === 'anthropic') return expandKeywordsWithAnthropic(keywords);
  throw new AiSummaryError(500, 'api_error', `Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
}

export async function summarizeCard(card: Card): Promise<string> {
  if (MOCK_AI_SUMMARY) {
    return card.body.trim().slice(0, 120) || card.title.trim();
  }
  if (AI_PROVIDER === 'gemini') return summarizeWithGemini(card);
  if (AI_PROVIDER === 'anthropic') return summarizeWithAnthropic(card);
  throw new AiSummaryError(500, 'api_error', `Unsupported AI_PROVIDER: ${AI_PROVIDER}`);
}

export function hasConfiguredProviderKey(): boolean {
  if (MOCK_AI_SUMMARY) return true;
  if (AI_PROVIDER === 'gemini') return !!getGeminiApiKey();
  if (AI_PROVIDER === 'anthropic') return !!getAnthropicApiKey();
  return false;
}

if (!MOCK_AI_SUMMARY && AI_PROVIDER === 'gemini' && !getGeminiApiKey()) {
  logger.error({ event: 'ai_missing_api_key', provider: 'gemini' }, '[AI SUMMARY] GEMINI_API_KEY is not configured');
} else if (!MOCK_AI_SUMMARY && AI_PROVIDER === 'anthropic' && !getAnthropicApiKey()) {
  logMissingApiKey();
}


export function isAiSummaryError(error: unknown): error is AiSummaryError {
  return error instanceof AiSummaryError;
}

