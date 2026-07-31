import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { Card } from '../domain/card.js';

export type PostgresRepositoryConfig = { connectionString: string; max?: number };

/** Parameterized PostgreSQL adapter for incremental service migration. */
export class PostgresRepository {
  readonly pool: Pool;
  constructor(config: PostgresRepositoryConfig) { this.pool = new Pool({ connectionString: config.connectionString, max: config.max }); }
  async health(): Promise<boolean> { const result = await this.pool.query('SELECT 1 AS ok'); return result.rows[0]?.ok === 1; }
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> { return (await this.pool.query<T>(text, values)).rows; }
  async close(): Promise<void> { await this.pool.end(); }
  async upsertCard(card: Card): Promise<void> {
    await this.pool.query(`INSERT INTO cards (id,title,body,summary,url,type,color,tags_json,links_json,kj_group_id,archived,archived_at,tokens_json,doc_length,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14,$15,$16) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, summary=EXCLUDED.summary, url=EXCLUDED.url, updated_at=EXCLUDED.updated_at`, [card.id, card.title, card.body, card.summary ?? null, card.url ?? null, card.type, card.color ?? null, JSON.stringify(card.tags ?? []), JSON.stringify(card.links ?? []), card.kjGroupId ?? null, card.archived, card.archivedAt ?? null, JSON.stringify(card.tokens ?? []), card.docLength ?? 0, card.createdAt, card.updatedAt]);
  }
}
