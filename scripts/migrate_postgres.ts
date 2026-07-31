import fs from 'node:fs/promises';
import { Pool } from 'pg';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('POSTGRES_URL is required');
const pool = new Pool({ connectionString });
try {
  const schema = await fs.readFile(new URL('../db/postgres_schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  console.log(JSON.stringify({ ok: true, driver: 'postgres', schema: 'applied' }));
} finally {
  await pool.end();
}
