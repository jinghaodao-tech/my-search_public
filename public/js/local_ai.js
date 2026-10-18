// On-device AI in Chrome (Prompt API, Translator, LanguageDetector).
// Nothing leaves the computer and nothing costs money. A model is downloaded only
// when the person presses a button (the browser requires a user action for that).
// When the browser has no on-device AI, every caller has a fallback without AI.
(function (global) {
  'use strict';

  var LM_OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['ja', 'en'] }],
    expectedOutputs: [{ type: 'text', languages: ['ja'] }],
  };
  var QUERY_SCHEMA = {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        maxItems: 4,
        items: { type: 'string' },
      },
    },
    required: ['queries'],
  };
  var PASSAGE_SCHEMA = {
    type: 'array',
    maxItems: 6,
    items: {
      type: 'object',
      properties: {
        paragraph: { type: 'integer' },
        quote: { type: 'string' },
        claim: { type: 'string' },
      },
      required: ['paragraph', 'quote', 'claim'],
    },
  };
  var PASSAGE_CHUNK_CHARS = 3500;

  // ─── pure helpers (tested) ────────────────────────────────

  function buildQueryPrompt(purpose) {
    return [
      'あなたは検索の専門家です。「調べたいこと」から、技術記事サイト（Qiita・Zenn）・GitHub・論文を検索する検索語を作ります。',
      '規則:',
      '- 検索語は3つ。各検索語は2〜3語をスペースで区切る',
      '- 1つ目と2つ目は日本語。調べたいことに出てくる大事な語をそのまま使う（言い換えて意味を変えない）',
      '- 3つ目は英語。専門用語の英語表記を使う',
      '- 「知りたい」「方法」「理由」のような語は入れない',
      '',
      '例: 調べたいこと: Reactのレンダリングが遅いときの直し方',
      '→ {"queries":["React レンダリング 遅い","React 再レンダリング 最適化","React rendering performance"]}',
      '',
      '調べたいこと: ' + purpose,
    ].join('\n');
  }

  function parseQueries(text) {
    var list = [];
    try {
      var json = JSON.parse(String(text).replace(/^```(?:json)?|```$/g, '').trim());
      list = Array.isArray(json) ? json : (json && Array.isArray(json.queries) ? json.queries : []);
    } catch (_) {
      list = String(text).split(/\n+/).map(function (line) { return line.replace(/^[\s\-*・\d.)]+/, ''); });
    }
    var seen = {};
    return list.map(function (q) { return String(q == null ? '' : q).replace(/["「」]/g, ' ').replace(/\s+/g, ' ').trim(); })
      .filter(function (q) {
        var key = q.toLowerCase();
        if (!q || q.length > 100 || seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .slice(0, 4);
  }

  /** Paragraphs → chunks of numbered lines that fit the on-device model's small context. */
  function chunkParagraphs(paragraphs, chunkChars) {
    var limit = chunkChars || PASSAGE_CHUNK_CHARS;
    var chunks = [];
    var current = [];
    var size = 0;
    (paragraphs || []).forEach(function (text, index) {
      var value = String(text || '').trim();
      if (!value || /^\[\[page:/.test(value) || /^!\[/.test(value)) return;
      if (value.length > limit) value = value.slice(0, limit);
      if (size + value.length > limit && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push({ index: index, text: value });
      size += value.length + 8;
    });
    if (current.length) chunks.push(current);
    return chunks;
  }

  function buildPassagePrompt(purpose, chunk) {
    return [
      '目的: ' + purpose,
      '',
      '下の段落から、目的の根拠・反対の根拠になる一節を選んでください。',
      '- quote は段落の文をそのまま一字一句写す（要約・言い換えはしない）。1〜2文まで',
      '- paragraph は段落の番号',
      '- claim はその一節が示すことを、必ず日本語で短く（原文が英語でも claim は日本語）',
      '- 合うものがなければ空の配列',
      '',
      chunk.map(function (item) { return '[' + (item.index + 1) + '] ' + item.text; }).join('\n'),
    ].join('\n');
  }

  function parsePassages(text) {
    var list;
    try {
      list = JSON.parse(String(text).replace(/^```(?:json)?|```$/g, '').trim());
    } catch (_) {
      return [];
    }
    if (!Array.isArray(list)) return [];
    return list.filter(function (row) { return row && typeof row === 'object'; }).map(function (row) {
      return { claim: String(row.claim || '').slice(0, 500), quote: String(row.quote || '').slice(0, 3000), source: 'S1' };
    }).filter(function (row) { return row.quote; });
  }

  // ─── browser APIs ─────────────────────────────────────────

  function api(name) {
    return typeof global[name] === 'function' || (global[name] && typeof global[name].create === 'function') ? global[name] : null;
  }

  async function availability(kind, options) {
    try {
      if (kind === 'prompt') {
        var LM = api('LanguageModel');
        return LM ? await LM.availability(LM_OPTIONS) : 'unavailable';
      }
      if (kind === 'translator') {
        var T = api('Translator');
        return T ? await T.availability(options || { sourceLanguage: 'en', targetLanguage: 'ja' }) : 'unavailable';
      }
      if (kind === 'detector') {
        var D = api('LanguageDetector');
        return D ? await D.availability() : 'unavailable';
      }
    } catch (_) {
      return 'unavailable';
    }
    return 'unavailable';
  }

  async function status() {
    var results = await Promise.all([availability('prompt'), availability('translator'), availability('detector')]);
    return { prompt: results[0], translator: results[1], detector: results[2] };
  }

  function monitor(onProgress) {
    return function (m) {
      m.addEventListener('downloadprogress', function (event) {
        if (onProgress) onProgress(typeof event.loaded === 'number' ? event.loaded : 0);
      });
    };
  }

  var sessions = {};

  /** Create (and on first use download) a model. Must be called from a click or key press. */
  async function prepare(kind, onProgress, options) {
    if (kind === 'prompt') {
      if (!sessions.prompt) sessions.prompt = await api('LanguageModel').create(Object.assign({}, LM_OPTIONS, { monitor: monitor(onProgress) }));
      return sessions.prompt;
    }
    if (kind === 'translator') {
      var opts = options || { sourceLanguage: 'en', targetLanguage: 'ja' };
      var key = 'translator:' + opts.sourceLanguage + '>' + opts.targetLanguage;
      if (!sessions[key]) sessions[key] = await api('Translator').create(Object.assign({}, opts, { monitor: monitor(onProgress) }));
      return sessions[key];
    }
    if (kind === 'detector') {
      if (!sessions.detector) sessions.detector = await api('LanguageDetector').create({ monitor: monitor(onProgress) });
      return sessions.detector;
    }
    throw new Error('unknown model: ' + kind);
  }

  async function isReady(kind) {
    return (await availability(kind)) === 'available';
  }

  /** One-off prompt on a fresh clone so earlier turns do not fill the small context window. */
  async function promptOnce(text, schema) {
    var base = await prepare('prompt');
    var session = typeof base.clone === 'function' ? await base.clone() : base;
    try {
      return await session.prompt(text, schema ? { responseConstraint: schema } : undefined);
    } finally {
      if (session !== base && typeof session.destroy === 'function') session.destroy();
    }
  }

  async function makeQueries(purpose) {
    return parseQueries(await promptOnce(buildQueryPrompt(purpose), QUERY_SCHEMA));
  }

  /** Proposed rows for the server to check word for word. Long texts: first `maxChunks` chunks only. */
  async function proposePassages(purpose, paragraphs, options) {
    var opts = options || {};
    var chunks = chunkParagraphs(paragraphs).slice(0, opts.maxChunks || 6);
    var rows = [];
    for (var i = 0; i < chunks.length; i++) {
      if (opts.onChunk) opts.onChunk(i + 1, chunks.length);
      try {
        rows = rows.concat(parsePassages(await promptOnce(buildPassagePrompt(purpose, chunks[i]), PASSAGE_SCHEMA)));
      } catch (error) {
        if (i === 0) throw error;
      }
    }
    return { rows: rows.slice(0, 60), chunks: chunks.length };
  }

  async function detectLanguage(text) {
    var detector = await prepare('detector');
    var results = await detector.detect(String(text || '').slice(0, 2000));
    return results && results[0] ? { language: results[0].detectedLanguage, confidence: results[0].confidence } : null;
  }

  /** Is this paragraph worth translating? (page markers, images, code-like lines and numbers are kept as they are) */
  function translatable(text) {
    var value = String(text || '').trim();
    if (!value || /^\[\[page:/.test(value) || /^!\[/.test(value)) return false;
    if (!/[A-Za-z]{2,}/.test(value)) return false;
    if (/^(```|\s{4})/.test(value)) return false;
    return true;
  }

  /** Mostly English? A cheap check used before asking the detector. */
  function looksEnglish(paragraphs) {
    var text = (paragraphs || []).filter(translatable).join(' ').slice(0, 4000);
    if (!text) return false;
    var latin = (text.match(/[A-Za-z]/g) || []).length;
    var cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
    return latin > 200 && cjk < latin * 0.05;
  }

  /** Translations aligned to paragraphs: translations[i] is the Japanese of paragraphs[i], or null. */
  async function translateParagraphs(paragraphs, options) {
    var opts = options || {};
    var translator = await prepare('translator', opts.onDownload, { sourceLanguage: opts.from || 'en', targetLanguage: 'ja' });
    var out = [];
    var total = paragraphs.filter(translatable).length;
    var done = 0;
    for (var i = 0; i < paragraphs.length; i++) {
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      if (!translatable(paragraphs[i])) { out.push(null); continue; }
      try {
        out.push(await translator.translate(String(paragraphs[i])));
      } catch (_) {
        out.push(null);
      }
      done += 1;
      if (opts.onProgress) opts.onProgress(done, total);
    }
    return out;
  }

  // ─── card summaries and keyword expansion (were done by an external AI before) ───

  var SUMMARY_CHUNK_CHARS = 3000;
  var SUMMARY_MAX_CHUNKS = 6;

  /** Body text → chunks for the small context window (page markers, images and code blocks left out). */
  function summaryChunks(body) {
    var text = String(body || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\[\[page:[^\]]*\]\]$/gm, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    var chunks = [];
    for (var at = 0; at < text.length && chunks.length < SUMMARY_MAX_CHUNKS; at += SUMMARY_CHUNK_CHARS) {
      chunks.push(text.slice(at, at + SUMMARY_CHUNK_CHARS));
    }
    return chunks;
  }

  function buildSummaryPrompt(title, text, partial) {
    return [
      partial
        ? '次の文章（長い記事の一部）の要点を、日本語で2文以内にまとめてください。'
        : '次の記事を、日本語で3行以内に要約してください。数字や固有名詞は省略しないでください。',
      '- 書かれていないことは書かない',
      '- 箇条書きの記号は付けない',
      '',
      'タイトル: ' + title,
      '本文:',
      text,
    ].join('\n');
  }

  function cleanSummary(text) {
    return String(text || '').replace(/^\s*(要約|まとめ)[:：]\s*/, '').replace(/^[\s・\-*]+/gm, '').trim().slice(0, 1000);
  }

  /** 3-line Japanese summary. Long texts: each part first, then a summary of the parts. */
  async function summarize(title, body, options) {
    var opts = options || {};
    var chunks = summaryChunks(body);
    if (chunks.length === 0) return '';
    if (chunks.length === 1) return cleanSummary(await promptOnce(buildSummaryPrompt(title, chunks[0], false)));
    var parts = [];
    for (var i = 0; i < chunks.length; i++) {
      if (opts.onProgress) opts.onProgress(i + 1, chunks.length + 1);
      parts.push(cleanSummary(await promptOnce(buildSummaryPrompt(title, chunks[i], true))));
    }
    if (opts.onProgress) opts.onProgress(chunks.length + 1, chunks.length + 1);
    return cleanSummary(await promptOnce(buildSummaryPrompt(title, parts.join('\n'), false)));
  }

  var EXPAND_SCHEMA = { type: 'object', properties: { terms: { type: 'array', maxItems: 10, items: { type: 'string' } } }, required: ['terms'] };

  function buildExpandPrompt(keywords) {
    return [
      'BM25検索で使う、次の検索語の類義語・関連語・表記ゆれを挙げてください。',
      '- 最大10個。元の検索語と同じものは入れない',
      '- 固有名詞はそのまま。日本語と英語の両方を入れてよい',
      '- 意味が変わる語（例: 再現 → 再現率）は入れない',
      '',
      '例: ["全文検索"] → {"terms":["フルテキスト検索","全文サーチ","full-text search","テキスト検索"]}',
      '',
      '検索語: ' + JSON.stringify(keywords),
    ].join('\n');
  }

  function parseExpanded(text, keywords) {
    var list = [];
    try {
      var json = JSON.parse(String(text).replace(/^```(?:json)?|```$/g, '').trim());
      list = Array.isArray(json) ? json : (json && Array.isArray(json.terms) ? json.terms : []);
    } catch (_) {
      return [];
    }
    var seen = {};
    (keywords || []).forEach(function (k) { seen[String(k).toLowerCase()] = true; });
    return list.map(function (t) { return String(t == null ? '' : t).trim(); }).filter(function (t) {
      var key = t.toLowerCase();
      if (!t || t.length > 50 || seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, 10);
  }

  async function expandKeywords(keywords) {
    return parseExpanded(await promptOnce(buildExpandPrompt(keywords), EXPAND_SCHEMA), keywords);
  }

  // A broad question ("IT業界で今問題になっていること") → concrete topics to search for. Suggestions only:
  // the person picks one, and the search itself stays plain keyword search.
  var TOPIC_SCHEMA = { type: 'object', properties: { topics: { type: 'array', maxItems: 6, items: { type: 'string' } } }, required: ['topics'] };

  function buildTopicPrompt(question) {
    return [
      '次の広い質問を、技術記事を探すための具体的なテーマに分けてください。',
      '- 4〜6個。各テーマは検索語として使える2〜4語をスペースで区切る',
      '- IT・ソフトウェア開発の記事を探す前提で考える',
      '- 質問の意味から外れたテーマは入れない。「問題」「最近」「勉強」のような広い語だけのテーマは作らない',
      '- 1つの分野に偏らせない。AI・セキュリティ・開発の進め方・インフラ・人材や働き方・法律や規制など、違う分野から選ぶ',
      '',
      '例: 質問: Web開発で今問題になっていること',
      '→ {"topics":["サプライチェーン攻撃 npm","サードパーティCookie 廃止","AI生成コード 品質","Webアクセシビリティ 対応"]}',
      '',
      '質問: ' + question,
    ].join('\n');
  }

  function parseTopics(text, question) {
    var list = [];
    try {
      var json = JSON.parse(String(text).replace(/^```(?:json)?|```$/g, '').trim());
      list = Array.isArray(json) ? json : (json && Array.isArray(json.topics) ? json.topics : []);
    } catch (_) {
      return [];
    }
    var seen = {};
    var q = String(question || '').trim();
    return list.map(function (t) { return String(t == null ? '' : t).replace(/["「」]/g, ' ').replace(/\s+/g, ' ').trim(); }).filter(function (t) {
      var key = t.toLowerCase();
      if (!t || t.length > 40 || t === q || seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, 6);
  }

  async function splitTopics(question) {
    return parseTopics(await promptOnce(buildTopicPrompt(question), TOPIC_SCHEMA), question);
  }

  var api_ = {
    splitTopics: splitTopics,
    buildTopicPrompt: buildTopicPrompt,
    parseTopics: parseTopics,
    summarize: summarize,
    expandKeywords: expandKeywords,
    summaryChunks: summaryChunks,
    buildSummaryPrompt: buildSummaryPrompt,
    buildExpandPrompt: buildExpandPrompt,
    parseExpanded: parseExpanded,
    translateParagraphs: translateParagraphs,
    looksEnglish: looksEnglish,
    translatable: translatable,
    status: status,
    availability: availability,
    prepare: prepare,
    isReady: isReady,
    makeQueries: makeQueries,
    proposePassages: proposePassages,
    detectLanguage: detectLanguage,
    // for tests
    buildQueryPrompt: buildQueryPrompt,
    parseQueries: parseQueries,
    chunkParagraphs: chunkParagraphs,
    buildPassagePrompt: buildPassagePrompt,
    parsePassages: parsePassages,
  };
  global.localAi = api_;
})(typeof window !== 'undefined' ? window : globalThis);
