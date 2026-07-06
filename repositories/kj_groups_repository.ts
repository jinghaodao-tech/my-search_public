import { db } from '../db/database.js';
import type { KJGroup } from '../domain/kjGroup.js';
import { updateCard } from './cards_repository.js';

type KJGroupRow = {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};


function rowToKJGroup(row: KJGroupRow): KJGroup {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? "#4D96FF",
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


export function loadKJGroups(): KJGroup[] {
  const rows = db.prepare(`
    SELECT * FROM kj_groups
    ORDER BY created_at ASC
  `).all() as KJGroupRow[];
  return rows.map(rowToKJGroup);
}

export function saveKJGroups(groups: KJGroup[]): void {
  const insert = db.prepare(`
    INSERT INTO kj_groups (
      id,
      name,
      color,
      description,
      created_at,
      updated_at
    )
    VALUES (
      @id,
      @name,
      @color,
      @description,
      @created_at,
      @updated_at
    )
  `);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM kj_groups`).run();
    for (const group of groups) {
      insert.run({
        id: group.id,
        name: group.name,
        color: group.color ?? null,
        description: group.description ?? null,
        created_at: group.createdAt,
        updated_at: group.updatedAt ?? group.createdAt,
      });
    }
  });
  tx();
}

// ════════════════════════════════════════════════════
//  § 3. カードCRUD
// ════════════════════════════════════════════════════


const KJ_COLORS = [
  '#FF6B6B', '#FFD93D', '#6BCB77', '#4D96FF',
  '#C77DFF', '#FF9A3C', '#00C9A7', '#F72585',
];

export function createKJGroup(name: string, description?: string, color?: string): KJGroup {
  const groups = loadKJGroups();
  const now = new Date().toISOString();
  const group: KJGroup = {
    id:          `kj_${Date.now()}`,
    name,
    description,
    color:       color ?? KJ_COLORS[groups.length % KJ_COLORS.length],
    createdAt:   now,
    updatedAt:   now,
  };
  db.prepare(`
    INSERT INTO kj_groups (
      id,
      name,
      color,
      description,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(group.id, group.name, group.color, group.description ?? null, group.createdAt, group.updatedAt);
  return group;
}

export function updateKJGroup(id: string, updates: Partial<KJGroup>): KJGroup | null {
  const existing = db.prepare(`SELECT * FROM kj_groups WHERE id = ?`).get(id) as KJGroupRow | undefined;
  if (!existing) return null;

  const current = rowToKJGroup(existing);
  const updated: KJGroup = {
    ...current,
    ...updates,
    id,
    updatedAt: new Date().toISOString(),
  };

  db.prepare(`
    UPDATE kj_groups
    SET
      name = ?,
      color = ?,
      description = ?,
      created_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    updated.name,
    updated.color ?? null,
    updated.description ?? null,
    updated.createdAt,
    updated.updatedAt,
    id,
  );
  return updated;
}

export function deleteKJGroup(id: string): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE cards
      SET kj_group_id = NULL, updated_at = ?
      WHERE kj_group_id = ?
    `).run(now, id);
    db.prepare(`DELETE FROM kj_groups WHERE id = ?`).run(id);
  });
  tx();
}

/** カードをKJグループへ割り当て（nullで解除） */
export async function assignKJGroup(cardId: string, groupId: string | null): Promise<void> {
  await updateCard(cardId, { kjGroupId: groupId ?? undefined });
}
