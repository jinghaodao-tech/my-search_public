import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/database.js';
import { getReaderText } from '../repositories/reader_texts_repository.js';
import { locateUniqueReaderQuote, parseReaderCardBody } from '../services/reader_service.js';
import { readerToolsSourceHash } from '../services/reader_tools_service.js';
import { parseBody, sendError } from '../services/http_service.js';

const MAX_MARKDOWN = 200_000;
const createDocumentSchema = z.object({ title: z.string().trim().min(1).max(200), markdown: z.string().max(MAX_MARKDOWN).default('') }).strict();
const updateDocumentSchema = createDocumentSchema.extend({ version: z.number().int().positive() }).strict();
const addSourceSchema = z.object({ sourceCardId: z.string().trim().min(1).max(200) }).strict();
const addThoughtNoteSchema = z.object({ thoughtNoteId: z.string().trim().min(1).max(200) }).strict();
const addCitationSchema = z.object({
  sourceCardId: z.string().trim().min(1).max(200),
  paragraphIndex: z.number().int().min(0).max(50_000),
  quote: z.string().trim().min(1).max(3000),
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(MAX_MARKDOWN),
  version: z.number().int().positive(),
  insertAt: z.number().int().min(0).max(MAX_MARKDOWN),
}).strict();
const addClipSchema = z.object({
  clipText: z.string().trim().min(1).max(5000),
  sourceTitle: z.string().trim().min(1).max(200),
  sourceUrl: z.string().url().max(2000).refine(value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } }, 'HTTPS URL required'),
  markdown: z.string().max(MAX_MARKDOWN),
  version: z.number().int().positive(),
  insertAt: z.number().int().min(0).max(MAX_MARKDOWN),
}).strict();

type DocumentRow = { id: string; title: string; content_json: string; version: number; created_at: string; updated_at: string };
type CitationRow = { id: string; source_card_id: string | null; source_title: string; source_url: string | null; quote_text: string; source_hash: string; paragraph_index: number; page_label: string | null; created_at: string };
type SourceRow = { id: string; source_card_id: string | null; source_title: string; source_url: string | null; added_at: string };

function parseMarkdown(row: DocumentRow): string {
  try {
    const value = JSON.parse(row.content_json) as { schemaVersion?: unknown; markdown?: unknown };
    return value?.schemaVersion === 1 && typeof value.markdown === 'string' ? value.markdown : '';
  } catch { return ''; }
}

function pageLabelAt(paragraphs: string[], paragraphIndex: number): string | null {
  for (let i = Math.min(paragraphIndex, paragraphs.length - 1); i >= 0; i -= 1) {
    const marker = /^\[\[page:(\d+)\|([^\]]*)\]\]$/.exec(paragraphs[i] ?? '');
    if (marker) return marker[2] ? `p. ${marker[2]}` : `PDF ${marker[1]}枚目（印刷ページ番号なし）`;
  }
  return null;
}

function loadDocument(id: string) {
  const row = db.prepare('SELECT id,title,content_json,version,created_at,updated_at FROM documents WHERE id=?').get(id) as DocumentRow | undefined;
  if (!row) return null;
  const markdown = parseMarkdown(row);
  const citations = db.prepare('SELECT id,source_card_id,source_title,source_url,quote_text,source_hash,paragraph_index,page_label,created_at FROM document_citations WHERE document_id=? ORDER BY created_at,id').all(id) as CitationRow[];
  const sources = db.prepare('SELECT id,source_card_id,source_title,source_url,added_at FROM document_sources WHERE document_id=? ORDER BY added_at,id').all(id) as SourceRow[];
  const clips = db.prepare('SELECT id,clip_text,source_title,source_url,created_at FROM document_clips WHERE document_id=? ORDER BY created_at,id').all(id) as Array<{ id: string; clip_text: string; source_title: string; source_url: string; created_at: string }>;
  const thoughtNotes = db.prepare(`SELECT n.id,n.title,n.body,n.kind,n.version,link.added_at AS addedAt
    FROM document_thought_notes link JOIN thought_notes n ON n.id=link.thought_note_id
    WHERE link.document_id=? ORDER BY link.added_at,n.id`).all(id);
  return {
    id: row.id, title: row.title, markdown, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    citations: citations.map(citation => {
      const source = citation.source_card_id ? db.prepare('SELECT body FROM cards WHERE id=?').get(citation.source_card_id) as { body: string | null } | undefined : undefined;
      const savedParagraphs = citation.source_card_id ? getReaderText(citation.source_card_id) : null;
      const parsed = source ? parseReaderCardBody(source.body ?? '') : null;
      const paragraphs = savedParagraphs ?? parsed?.paragraphs ?? [];
      const liveHash = paragraphs.length ? readerToolsSourceHash(paragraphs) : null;
      const anchor = citation.source_card_id && liveHash === citation.source_hash
        ? locateUniqueReaderQuote(citation.quote_text, paragraphs, citation.paragraph_index)
        : null;
      const verification = !citation.source_card_id ? 'source_missing'
        : !paragraphs.length ? 'text_missing'
          : liveHash !== citation.source_hash ? 'source_changed'
            : anchor?.status === 'matched' ? 'verified' : anchor?.status ?? 'missing';
      return { id: citation.id, sourceCardId: citation.source_card_id, sourceTitle: citation.source_title, sourceUrl: citation.source_url, quote: citation.quote_text, sourceHash: citation.source_hash, paragraphIndex: citation.paragraph_index, pageLabel: citation.page_label, createdAt: citation.created_at, verification };
    }),
    sources: sources.map(source => ({ id: source.id, sourceCardId: source.source_card_id, title: source.source_title, url: source.source_url, addedAt: source.added_at, missing: !source.source_card_id })),
    clips: clips.map(clip => ({ id: clip.id, text: clip.clip_text, sourceTitle: clip.source_title, sourceUrl: clip.source_url, createdAt: clip.created_at, verification: 'unverified_clip' })),
    thoughtNotes,
  };
}

export function createDocumentsRouter() {
  const router = express.Router();

  router.get('/documents', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const rows = query
      ? db.prepare(`SELECT id,title,content_json,version,created_at,updated_at FROM documents WHERE instr(lower(title || ' ' || COALESCE(json_extract(content_json,'$.markdown'),'')),lower(?))>0 ORDER BY updated_at DESC LIMIT 100`).all(query) as DocumentRow[]
      : db.prepare('SELECT id,title,content_json,version,created_at,updated_at FROM documents ORDER BY updated_at DESC LIMIT 100').all() as DocumentRow[];
    res.json({ documents: rows.map(row => ({ id: row.id, title: row.title, markdown: parseMarkdown(row), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at })) });
  });

  router.post('/documents', (req, res) => {
    const body = parseBody(createDocumentSchema, req, res);
    if (!body) return;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO documents(id,title,content_json,version,created_at,updated_at) VALUES(?,?,?,1,?,?)')
      .run(id, body.title, JSON.stringify({ schemaVersion: 1, markdown: body.markdown }), now, now);
    res.status(201).json({ document: loadDocument(id) });
  });

  router.get('/documents/:id', (req, res) => {
    const document = loadDocument(req.params.id);
    if (!document) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    res.json({ document });
  });

  router.put('/documents/:id', (req, res) => {
    const body = parseBody(updateDocumentSchema, req, res);
    if (!body) return;
    const save = db.transaction(() => {
      const current = db.prepare('SELECT version FROM documents WHERE id=?').get(req.params.id) as { version: number } | undefined;
      if (!current) return { kind: 'missing' as const };
      if (current.version !== body.version) return { kind: 'conflict' as const };
      const markerIds = [...body.markdown.matchAll(/\[\[citation:([0-9a-f-]{36})\]\]/g)].map(match => match[1]!);
      const clipIds = [...body.markdown.matchAll(/\[\[clip:([0-9a-f-]{36})\]\]/g)].map(match => match[1]!);
      if (new Set(markerIds).size !== markerIds.length || new Set(clipIds).size !== clipIds.length) return { kind: 'duplicate' as const };
      const known = markerIds.length
        ? db.prepare(`SELECT id FROM document_citations WHERE document_id=? AND id IN (${markerIds.map(() => '?').join(',')})`).all(req.params.id, ...markerIds) as Array<{ id: string }>
        : [];
      if (known.length !== markerIds.length) return { kind: 'unknown' as const };
      const knownClips = clipIds.length ? db.prepare(`SELECT id FROM document_clips WHERE document_id=? AND id IN (${clipIds.map(() => '?').join(',')})`).all(req.params.id, ...clipIds) as Array<{ id: string }> : [];
      if (knownClips.length !== clipIds.length) return { kind: 'unknown' as const };
      const result = db.prepare('UPDATE documents SET title=?,content_json=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(body.title, JSON.stringify({ schemaVersion: 1, markdown: body.markdown }), new Date().toISOString(), req.params.id, body.version);
      if (result.changes !== 1) return { kind: 'conflict' as const };
      const usedIds = new Set(markerIds);
      const existing = db.prepare('SELECT id FROM document_citations WHERE document_id=?').all(req.params.id) as Array<{ id: string }>;
      const remove = db.prepare('DELETE FROM document_citations WHERE id=? AND document_id=?');
      for (const citation of existing) if (!usedIds.has(citation.id)) remove.run(citation.id, req.params.id);
      const usedClipIds = new Set(clipIds);
      const existingClips = db.prepare('SELECT id FROM document_clips WHERE document_id=?').all(req.params.id) as Array<{ id: string }>;
      const removeClip = db.prepare('DELETE FROM document_clips WHERE id=? AND document_id=?');
      for (const clip of existingClips) if (!usedClipIds.has(clip.id)) removeClip.run(clip.id, req.params.id);
      return { kind: 'ok' as const };
    })();
    if (save.kind === 'missing') { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    if (save.kind !== 'ok') { sendError(req, res, 409, save.kind === 'conflict' ? '別の編集が先に保存されました。再読込してください' : '引用マーカーを確認できません。引用を戻すか、再読込してください', undefined, 'request_failed'); return; }
    res.json({ document: loadDocument(req.params.id) });
  });

  router.delete('/documents/:id', (req, res) => {
    const deleted = db.prepare('DELETE FROM documents WHERE id=?').run(req.params.id).changes;
    if (!deleted) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    res.json({ deleted: true });
  });

  router.post('/documents/:id/sources', (req, res) => {
    const body = parseBody(addSourceSchema, req, res);
    if (!body) return;
    const document = db.prepare('SELECT id FROM documents WHERE id=?').get(req.params.id);
    if (!document) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    const card = db.prepare('SELECT id,title,url,body FROM cards WHERE id=?').get(body.sourceCardId) as { id: string; title: string; url: string | null; body: string | null } | undefined;
    if (!card) { sendError(req, res, 404, '保存資料が見つかりません', undefined, 'card_not_found'); return; }
    const parsed = parseReaderCardBody(card.body ?? '');
    db.prepare('INSERT OR IGNORE INTO document_sources(id,document_id,source_card_id,source_title,source_url,added_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), req.params.id, card.id, parsed.source.title ?? card.title, parsed.source.url ?? card.url, new Date().toISOString());
    res.json({ document: loadDocument(req.params.id) });
  });

  router.delete('/documents/:id/sources/:sourceCardId', (req, res) => {
    db.prepare('DELETE FROM document_sources WHERE document_id=? AND source_card_id=?').run(req.params.id, req.params.sourceCardId);
    const document = loadDocument(req.params.id);
    if (!document) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    res.json({ document });
  });

  router.post('/documents/:id/thought-notes', (req, res) => {
    const body = parseBody(addThoughtNoteSchema, req, res);
    if (!body) return;
    if (!db.prepare('SELECT 1 FROM documents WHERE id=?').get(req.params.id)) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    if (!db.prepare('SELECT 1 FROM thought_notes WHERE id=?').get(body.thoughtNoteId)) { sendError(req, res, 404, '思考メモが見つかりません', undefined, 'request_failed'); return; }
    db.prepare('INSERT OR IGNORE INTO document_thought_notes(document_id,thought_note_id,added_at) VALUES(?,?,?)')
      .run(req.params.id, body.thoughtNoteId, new Date().toISOString());
    res.json({ document: loadDocument(req.params.id) });
  });

  router.delete('/documents/:id/thought-notes/:thoughtNoteId', (req, res) => {
    db.prepare('DELETE FROM document_thought_notes WHERE document_id=? AND thought_note_id=?').run(req.params.id, req.params.thoughtNoteId);
    const document = loadDocument(req.params.id);
    if (!document) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    res.json({ document });
  });

  router.post('/documents/:id/citations', (req, res) => {
    const body = parseBody(addCitationSchema, req, res);
    if (!body) return;
    const outcome = db.transaction(() => {
      const current = db.prepare('SELECT id,title,content_json,version FROM documents WHERE id=?').get(req.params.id) as Pick<DocumentRow, 'id'|'title'|'content_json'|'version'> | undefined;
      if (!current) return { kind: 'missing' as const };
      if (current.version !== body.version) return { kind: 'conflict' as const };
      const markdown = body.markdown;
      const markerIds = [...markdown.matchAll(/\[\[citation:([0-9a-f-]{36})\]\]/g)].map(match => match[1]!);
      if (new Set(markerIds).size !== markerIds.length) return { kind: 'invalid_markers' as const };
      const knownMarkerIds = markerIds.length
        ? db.prepare(`SELECT id FROM document_citations WHERE document_id=? AND id IN (${markerIds.map(() => '?').join(',')})`).all(req.params.id, ...markerIds) as Array<{ id: string }>
        : [];
      if (knownMarkerIds.length !== markerIds.length) return { kind: 'invalid_markers' as const };
      const clipIds = [...markdown.matchAll(/\[\[clip:([0-9a-f-]{36})\]\]/g)].map(match => match[1]!);
      if (new Set(clipIds).size !== clipIds.length) return { kind: 'invalid_markers' as const };
      const knownClips = clipIds.length
        ? db.prepare(`SELECT id FROM document_clips WHERE document_id=? AND id IN (${clipIds.map(() => '?').join(',')})`).all(req.params.id, ...clipIds) as Array<{ id: string }>
        : [];
      if (knownClips.length !== clipIds.length) return { kind: 'invalid_markers' as const };
      if (body.insertAt > markdown.length) return { kind: 'position' as const };
      const card = db.prepare('SELECT id,title,url,body FROM cards WHERE id=?').get(body.sourceCardId) as { id: string; title: string; url: string | null; body: string | null } | undefined;
      if (!card) return { kind: 'source_missing' as const };
      const parsed = parseReaderCardBody(card.body ?? '');
      const paragraphs = getReaderText(card.id) ?? parsed.paragraphs;
      if (!paragraphs.length) return { kind: 'text_missing' as const };
      const anchor = locateUniqueReaderQuote(body.quote, paragraphs, body.paragraphIndex);
      if (anchor.status !== 'matched' || anchor.paragraphIndex === null) return { kind: anchor.status as 'missing'|'ambiguous' };
      const hash = readerToolsSourceHash(paragraphs);
      const pageLabel = pageLabelAt(paragraphs, anchor.paragraphIndex);
      const id = randomUUID();
      const marker = `[[citation:${id}]]`;
      const nextMarkdown = `${markdown.slice(0, body.insertAt)}${marker}${markdown.slice(body.insertAt)}`;
      const now = new Date().toISOString();
      db.prepare('INSERT INTO document_citations(id,document_id,source_card_id,source_title,source_url,quote_text,source_hash,paragraph_index,page_label,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, current.id, card.id, parsed.source.title ?? card.title, parsed.source.url ?? card.url, body.quote, hash, anchor.paragraphIndex, pageLabel, now);
      db.prepare('INSERT OR IGNORE INTO document_sources(id,document_id,source_card_id,source_title,source_url,added_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), current.id, card.id, parsed.source.title ?? card.title, parsed.source.url ?? card.url, now);
      const saved = db.prepare('UPDATE documents SET title=?,content_json=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(body.title, JSON.stringify({ schemaVersion: 1, markdown: nextMarkdown }), now, current.id, current.version);
      if (saved.changes !== 1) throw new Error('document_conflict');
      return { kind: 'ok' as const, citationId: id };
    })();
    if (outcome.kind === 'missing') { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    if (outcome.kind === 'conflict') { sendError(req, res, 409, '別の編集が先に保存されました。再読込してください', undefined, 'request_failed'); return; }
    if (outcome.kind === 'invalid_markers') { sendError(req, res, 409, '原稿内の引用マーカーを確認できません。再読込してください', undefined, 'request_failed'); return; }
    if (outcome.kind === 'source_missing') { sendError(req, res, 404, '引用元の保存資料が見つかりません', undefined, 'card_not_found'); return; }
    if (outcome.kind === 'text_missing') { sendError(req, res, 409, '引用元に保存本文がありません', undefined, 'reader_text_missing'); return; }
    if (outcome.kind === 'position') { sendError(req, res, 400, '原稿のカーソル位置が古くなっています。再読込してください', undefined, 'request_failed'); return; }
    if (outcome.kind !== 'ok') { sendError(req, res, 409, outcome.kind === 'ambiguous' ? '引用が重複しているため場所を特定できません' : '引用が保存本文に一致しません', undefined, 'reader_quote_conflict'); return; }
    res.status(201).json({ document: loadDocument(req.params.id), citationId: outcome.citationId });
  });

  router.post('/documents/:id/clips', (req, res) => {
    const body = parseBody(addClipSchema, req, res);
    if (!body) return;
    const outcome = db.transaction(() => {
      const current = db.prepare('SELECT id,content_json,version FROM documents WHERE id=?').get(req.params.id) as Pick<DocumentRow, 'id'|'content_json'|'version'> | undefined;
      if (!current) return { kind: 'missing' as const };
      if (current.version !== body.version) return { kind: 'conflict' as const };
      const storedMarkdown = parseMarkdown({ ...current, title: '', created_at: '', updated_at: '' });
      if (storedMarkdown !== body.markdown || body.insertAt > body.markdown.length) return { kind: 'stale' as const };
      const markerIds = [...body.markdown.matchAll(/\[\[citation:([0-9a-f-]{36})\]\]/g)].map(match => match[1]!);
      const clipIds = [...body.markdown.matchAll(/\[\[clip:([0-9a-f-]{36})\]\]/g)].map(match => match[1]!);
      if (new Set(markerIds).size !== markerIds.length || new Set(clipIds).size !== clipIds.length) return { kind: 'invalid' as const };
      const knownCitations = markerIds.length ? db.prepare(`SELECT id FROM document_citations WHERE document_id=? AND id IN (${markerIds.map(() => '?').join(',')})`).all(req.params.id, ...markerIds) as Array<{ id: string }> : [];
      const knownClips = clipIds.length ? db.prepare(`SELECT id FROM document_clips WHERE document_id=? AND id IN (${clipIds.map(() => '?').join(',')})`).all(req.params.id, ...clipIds) as Array<{ id: string }> : [];
      if (knownCitations.length !== markerIds.length || knownClips.length !== clipIds.length) return { kind: 'invalid' as const };
      const id = randomUUID();
      const marker = `[[clip:${id}]]`;
      const markdown = `${body.markdown.slice(0, body.insertAt)}${marker}${body.markdown.slice(body.insertAt)}`;
      const now = new Date().toISOString();
      db.prepare('INSERT INTO document_clips(id,document_id,clip_text,source_title,source_url,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, current.id, body.clipText, body.sourceTitle, body.sourceUrl, now);
      const updated = db.prepare('UPDATE documents SET content_json=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(JSON.stringify({ schemaVersion: 1, markdown }), now, current.id, current.version);
      if (updated.changes !== 1) throw new Error('document_conflict');
      return { kind: 'ok' as const, id };
    })();
    if (outcome.kind === 'missing') { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    if (outcome.kind === 'conflict') { sendError(req, res, 409, '別の編集が先に保存されました。再読込してください', undefined, 'request_failed'); return; }
    if (outcome.kind === 'stale') { sendError(req, res, 409, '原稿が現在の保存版と一致しません。再読込してください', undefined, 'request_failed'); return; }
    if (outcome.kind !== 'ok') { sendError(req, res, 409, '引用またはクリップ位置を確認できません', undefined, 'request_failed'); return; }
    res.status(201).json({ document: loadDocument(req.params.id), clipId: outcome.id });
  });

  router.get('/documents/:id/export.md', (req, res) => {
    const document = loadDocument(req.params.id);
    if (!document) { sendError(req, res, 404, '原稿が見つかりません', undefined, 'request_failed'); return; }
    let markdown = document.markdown;
    for (const citation of document.citations) {
      const sourceLink = citation.sourceCardId && citation.verification === 'verified'
        ? `[#my-search-source:${encodeURIComponent(citation.sourceCardId)}:${citation.sourceHash}:${citation.paragraphIndex + 1}]`
        : '[出典位置を確認できません]';
      const replacement = `> ${citation.quote.replace(/\r\n?/g, '\n').split('\n').join('\n> ')}\n> — ${citation.sourceTitle}${citation.sourceUrl ? ` (${citation.sourceUrl})` : ''}${citation.pageLabel ? ` · ${citation.pageLabel}` : ''} · ${sourceLink}`;
      markdown = markdown.replace(`[[citation:${citation.id}]]`, replacement);
    }
    for (const clip of document.clips) {
      const replacement = `> ${clip.text.replace(/\r\n?/g, '\n').split('\n').join('\n> ')}\n> — ${clip.sourceTitle} (${clip.sourceUrl}) · **未検証クリップ：原文との照合はしていません**`;
      markdown = markdown.replace(`[[clip:${clip.id}]]`, replacement);
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="document-${document.id}.md"`);
    res.send(`# ${document.title}\n\n${markdown}\n`);
  });

  router.get('/reader/cards/:id/documents', (req, res) => {
    const documents = db.prepare(`SELECT DISTINCT d.id,d.title,d.version,d.updated_at,NULL AS citation_id,NULL AS paragraph_index,NULL AS quote_text,NULL AS page_label FROM documents d
      JOIN document_sources s ON s.document_id=d.id WHERE s.source_card_id=?
      UNION ALL
      SELECT d.id,d.title,d.version,d.updated_at,c.id AS citation_id,c.paragraph_index,c.quote_text,c.page_label FROM documents d
      JOIN document_citations c ON c.document_id=d.id WHERE c.source_card_id=?
      ORDER BY updated_at DESC,title`).all(req.params.id, req.params.id);
    res.json({ documents });
  });

  return router;
}
