import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/database.js';
import { loadCardsByIds } from '../repositories/cards_repository.js';
import { parseBody, sendError } from '../services/http_service.js';

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
  };
}

export function createInvestigationWorkspacesRouter() {
  const router = express.Router();

  router.get('/workspaces', (_req, res) => {
    const rows = db.prepare(`SELECT w.id,w.name,w.purpose,w.updated_at,
      (SELECT COUNT(*) FROM investigation_workspace_sources s WHERE s.workspace_id=w.id) AS source_count,
      (SELECT COUNT(*) FROM investigation_workspace_documents d WHERE d.workspace_id=w.id) AS document_count
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
