import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/database.js';
import { loadCardsByIds } from '../repositories/cards_repository.js';
import { getReaderText } from '../repositories/reader_texts_repository.js';
import { parseBody, sendError } from '../services/http_service.js';
import { locateUniqueReaderQuote, parseReaderCardBody } from '../services/reader_service.js';
import { readerToolsSourceHash } from '../services/reader_tools_service.js';

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: z.string().max(2000).default(''),
}).strict();
const updateWorkspaceSchema = createWorkspaceSchema.partial().strict();
const sourceSchema = z.object({ cardId: z.string().trim().min(1).max(200), groupId: z.string().trim().min(1).max(200).nullable().optional() }).strict();
const groupSchema = z.object({ name: z.string().trim().min(1).max(100), color: z.string().trim().max(30).nullable().optional(), position: z.number().int().min(0).max(100_000).default(0) }).strict();
const groupUpdateSchema = groupSchema.partial().strict();
const associationSchema = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const stateSchema = z.object({ state: z.unknown() }).strict();
const thoughtKinds = ['free', 'question', 'hypothesis', 'interpretation', 'evidence', 'counterargument', 'decision'] as const;
const thoughtSchema = z.object({
  title: z.string().max(200).default(''),
  body: z.string().max(20_000).default(''),
  kind: z.enum(thoughtKinds).default('free'),
}).strict().refine(value => Boolean(value.title.trim() || value.body.trim()), '思考メモのタイトルか本文を入力してください');
const thoughtUpdateSchema = thoughtSchema.extend({ version: z.number().int().positive() }).strict();
const thoughtAssociationSchema = z.object({ thoughtNoteId: z.string().trim().min(1).max(200) }).strict();
const thoughtPlacementSchema = z.object({
  groupId: z.string().trim().min(1).max(200).nullable(),
  position: z.number().int().min(0).max(100_000).optional(),
  x: z.number().finite().min(-100_000).max(100_000).optional(),
  y: z.number().finite().min(-100_000).max(100_000).optional(),
}).strict();
const thoughtLinkSchema = z.object({
  sourceThoughtId: z.string().trim().min(1).max(200),
  targetThoughtId: z.string().trim().min(1).max(200),
  description: z.string().max(300).default(''),
}).strict().refine(value => value.sourceThoughtId !== value.targetThoughtId, '同じメモ同士は関連付けられません');
const thoughtLinkUpdateSchema = z.object({ description: z.string().max(300) }).strict();
const thoughtReferenceSchema = z.object({
  sourceCardId: z.string().trim().min(1).max(200),
  quote: z.string().trim().min(1).max(3000),
}).strict();

type ThoughtRow = { id: string; title: string; body: string; kind: typeof thoughtKinds[number]; version: number; created_at: string; updated_at: string };
type ThoughtReferenceRow = { id: string; thought_note_id: string; source_card_id: string | null; source_title: string; source_url: string | null; quote_text: string; source_hash: string; paragraph_index: number; created_at: string };

function loadThoughtReferences(thoughtNoteId: string) {
  const rows = db.prepare(`SELECT id,thought_note_id,source_card_id,source_title,source_url,quote_text,source_hash,paragraph_index,created_at
    FROM thought_note_references WHERE thought_note_id=? ORDER BY created_at,id`).all(thoughtNoteId) as ThoughtReferenceRow[];
  return rows.map(row => {
    const card = row.source_card_id ? db.prepare('SELECT body FROM cards WHERE id=?').get(row.source_card_id) as { body: string | null } | undefined : undefined;
    const savedParagraphs = row.source_card_id ? getReaderText(row.source_card_id) : null;
    const paragraphs = savedParagraphs ?? (card ? parseReaderCardBody(card.body ?? '').paragraphs : []);
    const hash = paragraphs.length ? readerToolsSourceHash(paragraphs) : null;
    const anchor = row.source_card_id && hash === row.source_hash
      ? locateUniqueReaderQuote(row.quote_text, paragraphs, row.paragraph_index)
      : null;
    const verification = !row.source_card_id ? 'source_missing'
      : !paragraphs.length ? 'text_missing'
        : hash !== row.source_hash ? 'source_changed'
          : anchor?.status === 'matched' ? 'verified' : anchor?.status ?? 'missing';
    return {
      id: row.id, sourceCardId: row.source_card_id, sourceTitle: row.source_title, sourceUrl: row.source_url,
      quote: row.quote_text, sourceHash: row.source_hash, paragraphIndex: row.paragraph_index,
      createdAt: row.created_at, verification,
    };
  });
}

function loadThoughtNote(id: string) {
  const row = db.prepare('SELECT id,title,body,kind,version,created_at,updated_at FROM thought_notes WHERE id=?').get(id) as ThoughtRow | undefined;
  return row ? {
    id: row.id, title: row.title, body: row.body, kind: row.kind, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, references: loadThoughtReferences(id),
  } : null;
}

function readState(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function existsWorkspace(id: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM investigation_workspaces WHERE id=?').get(id));
}

function loadWorkspace(id: string) {
  const row = db.prepare('SELECT id,name,purpose,state_json,created_at,updated_at FROM investigation_workspaces WHERE id=?').get(id) as {
    id: string; name: string; purpose: string; state_json: string; created_at: string; updated_at: string;
  } | undefined;
  if (!row) return null;
  const groups = db.prepare('SELECT id,name,color,position,created_at FROM investigation_workspace_groups WHERE workspace_id=? ORDER BY position,name,id').all(id);
  const sourceRows = db.prepare(`SELECT card_id,group_id,position,added_at FROM investigation_workspace_sources WHERE workspace_id=? ORDER BY position,added_at,card_id`).all(id) as Array<{ card_id: string; group_id: string | null; position: number; added_at: string }>;
  const cardsById = new Map(loadCardsByIds(sourceRows.map(source => source.card_id)).map(card => [card.id, card]));
  const sources = sourceRows.flatMap(source => {
    const card = cardsById.get(source.card_id);
    return card ? [{ card, groupId: source.group_id, position: source.position, addedAt: source.added_at }] : [];
  });
  const documents = db.prepare(`SELECT d.id,d.title,d.version,d.updated_at,w.added_at
    FROM investigation_workspace_documents w JOIN documents d ON d.id=w.document_id
    WHERE w.workspace_id=? ORDER BY w.added_at DESC,d.title`).all(id);
  const searches = db.prepare(`SELECT s.id,s.payload,s.updated_at,w.added_at
    FROM investigation_workspace_searches w JOIN saved_searches s ON s.id=w.saved_search_id
    WHERE w.workspace_id=? ORDER BY w.added_at DESC,s.updated_at DESC`).all(id) as Array<{ id: string; payload: string; updated_at: string; added_at: string }>;
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    state: readState(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    groups,
    sources,
    documents,
    searches: searches.map(search => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(search.payload) as Record<string, unknown>; } catch { /* preserve malformed legacy payload as an unavailable label */ }
      return { id: search.id, name: typeof payload.name === 'string' ? payload.name : '保存した検索', updatedAt: search.updated_at, addedAt: search.added_at };
    }),
    thoughts: (db.prepare(`SELECT n.id,n.title,n.body,n.kind,n.version,n.created_at,n.updated_at,
      w.group_id,w.position,w.position_x,w.position_y,w.added_at
      FROM investigation_workspace_thoughts w JOIN thought_notes n ON n.id=w.thought_note_id
      WHERE w.workspace_id=? ORDER BY w.position,w.added_at,n.id`).all(id) as Array<ThoughtRow & { group_id: string | null; position: number; position_x: number; position_y: number; added_at: string }>).map(note => ({
        id: note.id, title: note.title, body: note.body, kind: note.kind, version: note.version,
        createdAt: note.created_at, updatedAt: note.updated_at, groupId: note.group_id,
        position: note.position, x: note.position_x, y: note.position_y, addedAt: note.added_at,
        references: loadThoughtReferences(note.id),
      })),
    thoughtLinks: db.prepare(`SELECT id,source_thought_id AS sourceThoughtId,target_thought_id AS targetThoughtId,
      description,created_at AS createdAt,updated_at AS updatedAt
      FROM investigation_workspace_thought_links WHERE workspace_id=? ORDER BY created_at,id`).all(id),
  };
}

export function createInvestigationWorkspacesRouter() {
  const router = express.Router();

  router.get('/workspaces', (_req, res) => {
    const rows = db.prepare(`SELECT w.id,w.name,w.purpose,w.updated_at,
      (SELECT COUNT(*) FROM investigation_workspace_sources s WHERE s.workspace_id=w.id) AS source_count,
      (SELECT COUNT(*) FROM investigation_workspace_documents d WHERE d.workspace_id=w.id) AS document_count,
      (SELECT COUNT(*) FROM investigation_workspace_thoughts t WHERE t.workspace_id=w.id) AS thought_count
      FROM investigation_workspaces w ORDER BY w.updated_at DESC,w.name`).all();
    res.json({ workspaces: rows });
  });

  router.post('/workspaces', (req, res) => {
    const body = parseBody(createWorkspaceSchema, req, res);
    if (!body) return;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO investigation_workspaces(id,name,purpose,state_json,created_at,updated_at) VALUES(?,?,?,\'{}\',?,?)')
      .run(id, body.name, body.purpose, now, now);
    res.status(201).json({ workspace: loadWorkspace(id) });
  });

  router.get('/workspaces/:id', (req, res) => {
    const workspace = loadWorkspace(req.params.id);
    if (!workspace) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    res.json({ workspace });
  });

  router.put('/workspaces/:id', (req, res) => {
    const body = parseBody(updateWorkspaceSchema, req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    const fields: string[] = [];
    const values: Array<string> = [];
    if (body.name !== undefined) { fields.push('name=?'); values.push(body.name); }
    if (body.purpose !== undefined) { fields.push('purpose=?'); values.push(body.purpose); }
    if (fields.length) {
      fields.push('updated_at=?'); values.push(new Date().toISOString(), req.params.id);
      db.prepare(`UPDATE investigation_workspaces SET ${fields.join(',')} WHERE id=?`).run(...values);
    }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.delete('/workspaces/:id', (req, res) => {
    const result = db.prepare('DELETE FROM investigation_workspaces WHERE id=?').run(req.params.id);
    if (!result.changes) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    res.json({ ok: true });
  });

  router.put('/workspaces/:id/state', (req, res) => {
    const body = parseBody(stateSchema, req, res);
    if (!body) return;
    if (body.state === undefined) { sendError(req, res, 400, '保存状態を指定してください'); return; }
    const serialized = JSON.stringify(body.state);
    if (typeof serialized !== 'string' || serialized.length > 20_000 || !body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
      sendError(req, res, 400, '保存状態は20KB以下のオブジェクトで指定してください'); return;
    }
    const result = db.prepare('UPDATE investigation_workspaces SET state_json=?,updated_at=? WHERE id=?').run(serialized, new Date().toISOString(), req.params.id);
    if (!result.changes) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    res.json({ state: readState(serialized) });
  });

  router.post('/workspaces/:id/sources', (req, res) => {
    const body = parseBody(sourceSchema, req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    if (!db.prepare('SELECT 1 FROM cards WHERE id=?').get(body.cardId)) { sendError(req, res, 404, '保存資料が見つかりません'); return; }
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO investigation_workspace_sources(workspace_id,card_id,group_id,position,added_at)
        VALUES(?,?,?,COALESCE((SELECT MAX(position)+1 FROM investigation_workspace_sources WHERE workspace_id=?),0),?)
        ON CONFLICT(workspace_id,card_id) DO UPDATE SET group_id=COALESCE(excluded.group_id,investigation_workspace_sources.group_id)`)
        .run(req.params.id, body.cardId, body.groupId ?? null, req.params.id, now);
    } catch {
      sendError(req, res, 400, '資料またはグループを確認できません'); return;
    }
    res.status(201).json({ workspace: loadWorkspace(req.params.id) });
  });

  router.put('/workspaces/:id/sources/:cardId', (req, res) => {
    const body = parseBody(z.object({ groupId: z.string().trim().min(1).max(200).nullable(), position: z.number().int().min(0).max(100_000).optional() }).strict(), req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    try {
      const result = db.prepare(`UPDATE investigation_workspace_sources SET group_id=?,position=COALESCE(?,position)
        WHERE workspace_id=? AND card_id=?`).run(body.groupId, body.position ?? null, req.params.id, req.params.cardId);
      if (!result.changes) { sendError(req, res, 404, '調査資料が見つかりません'); return; }
    } catch { sendError(req, res, 400, 'グループを確認できません'); return; }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.delete('/workspaces/:id/sources/:cardId', (req, res) => {
    const result = db.prepare('DELETE FROM investigation_workspace_sources WHERE workspace_id=? AND card_id=?').run(req.params.id, req.params.cardId);
    if (!result.changes) { sendError(req, res, 404, '調査資料が見つかりません'); return; }
    res.json({ ok: true });
  });

  router.post('/workspaces/:id/groups', (req, res) => {
    const body = parseBody(groupSchema, req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    const id = randomUUID();
    db.prepare('INSERT INTO investigation_workspace_groups(workspace_id,id,name,color,position,created_at) VALUES(?,?,?,?,?,?)')
      .run(req.params.id, id, body.name, body.color ?? null, body.position, new Date().toISOString());
    res.status(201).json({ workspace: loadWorkspace(req.params.id), groupId: id });
  });

  router.put('/workspaces/:id/groups/:groupId', (req, res) => {
    const body = parseBody(groupUpdateSchema, req, res);
    if (!body) return;
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    if (body.name !== undefined) { fields.push('name=?'); values.push(body.name); }
    if (body.color !== undefined) { fields.push('color=?'); values.push(body.color); }
    if (body.position !== undefined) { fields.push('position=?'); values.push(body.position); }
    if (fields.length) {
      values.push(req.params.id, req.params.groupId);
      const updated = db.prepare(`UPDATE investigation_workspace_groups SET ${fields.join(',')} WHERE workspace_id=? AND id=?`).run(...values);
      if (!updated.changes) { sendError(req, res, 404, 'グループが見つかりません'); return; }
    }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.delete('/workspaces/:id/groups/:groupId', (req, res) => {
    const changed = db.transaction(() => {
      db.prepare('UPDATE investigation_workspace_sources SET group_id=NULL WHERE workspace_id=? AND group_id=?').run(req.params.id, req.params.groupId);
      db.prepare('UPDATE investigation_workspace_thoughts SET group_id=NULL WHERE workspace_id=? AND group_id=?').run(req.params.id, req.params.groupId);
      return db.prepare('DELETE FROM investigation_workspace_groups WHERE workspace_id=? AND id=?').run(req.params.id, req.params.groupId).changes;
    })();
    if (!changed) { sendError(req, res, 404, 'グループが見つかりません'); return; }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.post('/workspaces/:id/documents', (req, res) => associate(req, res, 'investigation_workspace_documents', 'document_id'));
  router.delete('/workspaces/:id/documents/:documentId', (req, res) => detach(req, res, 'investigation_workspace_documents', 'document_id', req.params.documentId));
  router.post('/workspaces/:id/searches', (req, res) => associate(req, res, 'investigation_workspace_searches', 'saved_search_id'));
  router.delete('/workspaces/:id/searches/:searchId', (req, res) => detach(req, res, 'investigation_workspace_searches', 'saved_search_id', req.params.searchId));

  router.get('/workspaces/:id/graph', (req, res) => {
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    const workspaceCards = loadWorkspace(req.params.id)?.sources ?? [];
    const ids = new Set(workspaceCards.map(source => source.card.id));
    const nodes = workspaceCards.map(({ card, groupId }) => ({
      id: card.id, label: card.title.slice(0, 40), title: card.summary ?? card.body.slice(0, 100), group: groupId ?? 'ungrouped',
      externalLinkCount: card.links.filter(id => !ids.has(id)).length,
    }));
    const edges = workspaceCards.flatMap(({ card }) => card.links.filter(id => ids.has(id)).map(id => ({ from: card.id, to: id })));
    res.json({ nodes, edges, externalLinks: nodes.reduce((sum, node) => sum + node.externalLinkCount, 0) });
  });

  router.get('/workspaces/:id/thought-map', (req, res) => {
    const workspace = loadWorkspace(req.params.id);
    if (!workspace) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    res.json({
      nodes: workspace.thoughts.map((note: any) => ({ id: note.id, label: note.title || note.body.slice(0, 48), title: '', kind: note.kind, x: note.x, y: note.y, group: note.groupId ?? 'ungrouped' })),
      edges: workspace.thoughtLinks.map((link: any) => ({ id: link.id, from: link.sourceThoughtId, to: link.targetThoughtId, label: link.description, arrows: 'to' })),
    });
  });

  router.get('/thought-notes', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
    const relatedSearch = req.query.mode === 'related' && query.length > 0;
    const terms = relatedSearch ? [...new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 8) : [];
    const rows = relatedSearch && terms.length
      ? db.prepare(`SELECT id,title,body,kind,version,created_at,updated_at,
          (${terms.map(() => "CASE WHEN instr(lower(title || ' ' || body),?)>0 THEN 1 ELSE 0 END").join(' + ')}) AS matched_terms
        FROM thought_notes WHERE ${terms.map(() => "instr(lower(title || ' ' || body),?)>0").join(' OR ')}
        ORDER BY matched_terms DESC,updated_at DESC LIMIT 30`).all(...terms, ...terms)
      : query
        ? db.prepare(`SELECT id,title,body,kind,version,created_at,updated_at FROM thought_notes
          WHERE instr(lower(title || ' ' || body),lower(?))>0 ORDER BY updated_at DESC LIMIT 100`).all(query)
        : db.prepare('SELECT id,title,body,kind,version,created_at,updated_at FROM thought_notes ORDER BY updated_at DESC LIMIT 100').all();
    const matchedCount = relatedSearch && terms.length
      ? Number((db.prepare(`SELECT COUNT(*) AS count FROM thought_notes WHERE ${terms.map(() => "instr(lower(title || ' ' || body),?)>0").join(' OR ')}`).get(...terms) as { count: number }).count)
      : relatedSearch ? Number((db.prepare("SELECT COUNT(*) AS count FROM thought_notes WHERE instr(lower(title || ' ' || body),lower(?))>0").get(query) as { count: number }).count) : undefined;
    res.json({ thoughts: (rows as ThoughtRow[]).map(row => ({
      id: row.id, title: row.title, body: row.body, kind: row.kind, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(relatedSearch ? { lexicalMatchCount: Number((row as ThoughtRow & { matched_terms?: number }).matched_terms ?? 0) } : {}),
    })), scope: relatedSearch ? { method: terms.length ? 'sqlite-substring-token-overlap' : 'sqlite-substring-phrase', searchedTerms: terms, matchedCount, returnedCount: rows.length, maxCandidates: terms.length ? 30 : 100, semanticMatch: false } : undefined });
  });

  router.post('/thought-notes', (req, res) => {
    const body = parseBody(thoughtSchema, req, res);
    if (!body) return;
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare('INSERT INTO thought_notes(id,title,body,kind,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
      .run(id, body.title.trim(), body.body, body.kind, now, now);
    res.status(201).json({ thought: loadThoughtNote(id) });
  });

  router.get('/thought-notes/:id', (req, res) => {
    const thought = loadThoughtNote(req.params.id);
    if (!thought) { sendError(req, res, 404, '思考メモが見つかりません'); return; }
    res.json({ thought });
  });

  router.put('/thought-notes/:id', (req, res) => {
    const body = parseBody(thoughtUpdateSchema, req, res);
    if (!body) return;
    const now = new Date().toISOString();
    const result = db.transaction(() => {
      const current = db.prepare('SELECT id,title,body,kind,version FROM thought_notes WHERE id=?').get(req.params.id) as Pick<ThoughtRow, 'id'|'title'|'body'|'kind'|'version'> | undefined;
      if (!current) return { kind: 'missing' as const };
      if (current.version !== body.version) return { kind: 'conflict' as const, current };
      db.prepare(`INSERT OR IGNORE INTO thought_note_revisions(thought_note_id,version,title,body,kind,saved_at)
        VALUES(?,?,?,?,?,?)`).run(current.id, current.version, current.title, current.body, current.kind, now);
      db.prepare(`UPDATE thought_notes SET title=?,body=?,kind=?,version=version+1,updated_at=? WHERE id=? AND version=?`)
        .run(body.title.trim(), body.body, body.kind, now, current.id, body.version);
      return { kind: 'saved' as const };
    })();
    if (result.kind === 'missing') { sendError(req, res, 404, '思考メモが見つかりません'); return; }
    if (result.kind === 'conflict') { res.status(409).json({ error: 'このメモは別の場所で更新されました。現在の内容を再読み込みしてください。', current: loadThoughtNote(req.params.id) }); return; }
    res.json({ thought: loadThoughtNote(req.params.id) });
  });

  router.delete('/thought-notes/:id', (req, res) => {
    const result = db.prepare('DELETE FROM thought_notes WHERE id=?').run(req.params.id);
    if (!result.changes) { sendError(req, res, 404, '思考メモが見つかりません'); return; }
    res.json({ ok: true });
  });

  router.get('/thought-notes/:id/revisions', (req, res) => {
    if (!db.prepare('SELECT 1 FROM thought_notes WHERE id=?').get(req.params.id)) { sendError(req, res, 404, '思考メモが見つかりません'); return; }
    const revisions = db.prepare(`SELECT version,title,body,kind,saved_at AS savedAt FROM thought_note_revisions
      WHERE thought_note_id=? ORDER BY version DESC LIMIT 100`).all(req.params.id);
    res.json({ revisions });
  });

  router.post('/thought-notes/:id/references', (req, res) => {
    const body = parseBody(thoughtReferenceSchema, req, res);
    if (!body) return;
    if (!db.prepare('SELECT 1 FROM thought_notes WHERE id=?').get(req.params.id)) { sendError(req, res, 404, '思考メモが見つかりません'); return; }
    const card = db.prepare('SELECT id,title,url,body FROM cards WHERE id=?').get(body.sourceCardId) as { id: string; title: string; url: string | null; body: string | null } | undefined;
    if (!card) { sendError(req, res, 404, '出典カードが見つかりません'); return; }
    const paragraphs = getReaderText(card.id) ?? parseReaderCardBody(card.body ?? '').paragraphs;
    const anchor = locateUniqueReaderQuote(body.quote, paragraphs);
    if (anchor.status !== 'matched' || anchor.paragraphIndex === null) {
      sendError(req, res, anchor.status === 'ambiguous' ? 409 : 422, anchor.status === 'ambiguous' ? '同じ引用が複数箇所にあります。Readerで場所を確認してから追加してください。' : '引用文が保存済み原文に見つかりません'); return;
    }
    const id = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO thought_note_references(id,thought_note_id,source_card_id,source_title,source_url,quote_text,source_hash,paragraph_index,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, req.params.id, card.id, card.title, card.url, body.quote, readerToolsSourceHash(paragraphs), anchor.paragraphIndex, now);
    res.status(201).json({ reference: loadThoughtReferences(req.params.id).find(reference => reference.id === id) });
  });

  router.delete('/thought-notes/:id/references/:referenceId', (req, res) => {
    const result = db.prepare('DELETE FROM thought_note_references WHERE id=? AND thought_note_id=?').run(req.params.referenceId, req.params.id);
    if (!result.changes) { sendError(req, res, 404, '出典参照が見つかりません'); return; }
    res.json({ ok: true });
  });

  router.post('/workspaces/:id/thought-notes', (req, res) => {
    const body = parseBody(thoughtAssociationSchema, req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    const position = db.prepare('SELECT COALESCE(MAX(position)+1,0) AS position FROM investigation_workspace_thoughts WHERE workspace_id=?').get(req.params.id) as { position: number };
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT OR IGNORE INTO investigation_workspace_thoughts(workspace_id,thought_note_id,position,position_x,position_y,added_at)
        VALUES(?,?,?,?,?,?)`).run(req.params.id, body.thoughtNoteId, position.position, (position.position % 4) * 220, Math.floor(position.position / 4) * 150, now);
    } catch { sendError(req, res, 404, '思考メモが見つかりません'); return; }
    res.status(201).json({ workspace: loadWorkspace(req.params.id) });
  });

  router.put('/workspaces/:id/thought-notes/:thoughtNoteId', (req, res) => {
    const body = parseBody(thoughtPlacementSchema, req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    try {
      const result = db.prepare(`UPDATE investigation_workspace_thoughts
        SET group_id=?,position=COALESCE(?,position),position_x=COALESCE(?,position_x),position_y=COALESCE(?,position_y)
        WHERE workspace_id=? AND thought_note_id=?`).run(body.groupId, body.position ?? null, body.x ?? null, body.y ?? null, req.params.id, req.params.thoughtNoteId);
      if (!result.changes) { sendError(req, res, 404, 'この調査に関連付けられた思考メモがありません'); return; }
    } catch { sendError(req, res, 400, '分類を確認できません'); return; }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.delete('/workspaces/:id/thought-notes/:thoughtNoteId', (req, res) => {
    const result = db.prepare('DELETE FROM investigation_workspace_thoughts WHERE workspace_id=? AND thought_note_id=?').run(req.params.id, req.params.thoughtNoteId);
    if (!result.changes) { sendError(req, res, 404, '関連付けが見つかりません'); return; }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.post('/workspaces/:id/thought-links', (req, res) => {
    const body = parseBody(thoughtLinkSchema, req, res);
    if (!body) return;
    if (!existsWorkspace(req.params.id)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    const id = randomUUID(); const now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO investigation_workspace_thought_links(workspace_id,id,source_thought_id,target_thought_id,description,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`).run(req.params.id, id, body.sourceThoughtId, body.targetThoughtId, body.description.trim(), now, now);
    } catch { sendError(req, res, 400, '両方のメモをこの調査に追加し、重複しない関係を指定してください'); return; }
    res.status(201).json({ workspace: loadWorkspace(req.params.id), linkId: id });
  });

  router.put('/workspaces/:id/thought-links/:linkId', (req, res) => {
    const body = parseBody(thoughtLinkUpdateSchema, req, res);
    if (!body) return;
    const result = db.prepare('UPDATE investigation_workspace_thought_links SET description=?,updated_at=? WHERE workspace_id=? AND id=?')
      .run(body.description.trim(), new Date().toISOString(), req.params.id, req.params.linkId);
    if (!result.changes) { sendError(req, res, 404, '思考メモの関係が見つかりません'); return; }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  router.delete('/workspaces/:id/thought-links/:linkId', (req, res) => {
    const result = db.prepare('DELETE FROM investigation_workspace_thought_links WHERE workspace_id=? AND id=?').run(req.params.id, req.params.linkId);
    if (!result.changes) { sendError(req, res, 404, '思考メモの関係が見つかりません'); return; }
    res.json({ workspace: loadWorkspace(req.params.id) });
  });

  function associate(req: express.Request, res: express.Response, table: 'investigation_workspace_documents' | 'investigation_workspace_searches', column: 'document_id' | 'saved_search_id') {
    const body = parseBody(associationSchema, req, res);
    if (!body) return;
    const workspaceId = String(req.params.id ?? '');
    if (!existsWorkspace(workspaceId)) { sendError(req, res, 404, '調査ワークスペースが見つかりません'); return; }
    const now = new Date().toISOString();
    try {
      db.prepare(`INSERT OR IGNORE INTO ${table}(workspace_id,${column},added_at) VALUES(?,?,?)`).run(workspaceId, body.id, now);
    } catch { sendError(req, res, 404, '関連資料または保存検索が見つかりません'); return; }
    res.status(201).json({ workspace: loadWorkspace(workspaceId) });
  }

  function detach(req: express.Request, res: express.Response, table: 'investigation_workspace_documents' | 'investigation_workspace_searches', column: 'document_id' | 'saved_search_id', value: string) {
    const workspaceId = String(req.params.id ?? '');
    const result = db.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND ${column}=?`).run(workspaceId, value);
    if (!result.changes) { sendError(req, res, 404, '関連付けが見つかりません'); return; }
    res.json({ ok: true });
  }

  return router;
}
