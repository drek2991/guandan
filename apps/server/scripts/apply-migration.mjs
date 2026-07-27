import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';

const migrationPath = resolve(
  process.cwd(),
  'apps/server/migrations/202607270001_create_infrastructure_smoke_probe.sql',
);
const databaseUrl = process.env.DATABASE_URL;
const caPath = process.env.DATABASE_CA_PATH;

if (databaseUrl === undefined || caPath === undefined) {
  throw new Error('Database migration configuration is unavailable');
}

const url = new URL(databaseUrl);
url.searchParams.delete('sslmode');
const [ca, migration] = await Promise.all([
  readFile(resolve(process.cwd(), caPath), 'utf8'),
  readFile(migrationPath, 'utf8'),
]);
const pool = new Pool({
  application_name: 'guandan-migration',
  connectionString: url.href,
  max: 1,
  ssl: { ca, rejectUnauthorized: true },
});

try {
  await pool.query(migration);
  const structure = await pool.query(`
    SELECT count(*)::int AS "columnCount", c.relrowsecurity AS "rlsEnabled"
    FROM information_schema.columns columns
    JOIN pg_class c ON c.oid = 'public.infrastructure_smoke_probe'::regclass
    WHERE columns.table_schema = 'public'
      AND columns.table_name = 'infrastructure_smoke_probe'
    GROUP BY c.relrowsecurity
  `);
  const row = structure.rows[0];
  if (row?.columnCount !== 4 || row.rlsEnabled !== true) {
    throw new Error('Migration verification failed');
  }
  console.log('Migration applied and table structure verified');
} finally {
  await pool.end();
}
