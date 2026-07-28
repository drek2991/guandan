import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';

import {
  PRIMARY_KEY_METADATA_QUERY,
  isExpectedSmokePrimaryKey,
} from './verify-primary-key.mjs';

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

const client = await pool.connect();
let transactionStarted = false;

try {
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query(migration);
  await verifyMigration(client);
  await client.query('COMMIT');
  transactionStarted = false;
  console.log('Migration applied and exact table semantics verified');
} catch (error) {
  if (transactionStarted) {
    await client.query('ROLLBACK');
  }
  throw error;
} finally {
  client.release();
  await pool.end();
}

async function verifyMigration(database) {
  const columns = await database.query(`
    SELECT
      attribute.attname AS "columnName",
      format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
      attribute.attnotnull AS "notNull",
      pg_get_expr(default_value.adbin, default_value.adrelid) AS "defaultExpression"
    FROM pg_attribute attribute
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
      AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.infrastructure_smoke_probe'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum
  `);

  const expectedColumns = [
    {
      columnName: 'probe_key',
      dataType: 'text',
      notNull: true,
      defaultExpression: null,
    },
    {
      columnName: 'last_command_id',
      dataType: 'uuid',
      notNull: true,
      defaultExpression: null,
    },
    {
      columnName: 'last_probe_token',
      dataType: 'uuid',
      notNull: true,
      defaultExpression: null,
    },
    {
      columnName: 'updated_at',
      dataType: 'timestamp with time zone',
      notNull: true,
      defaultExpression: 'statement_timestamp()',
    },
  ];

  if (JSON.stringify(columns.rows) !== JSON.stringify(expectedColumns)) {
    throw new Error('Migration verification failed: incompatible columns');
  }

  const primaryKeys = await database.query(PRIMARY_KEY_METADATA_QUERY);
  if (!isExpectedSmokePrimaryKey(primaryKeys.rows)) {
    throw new Error('Migration verification failed: incompatible primary key');
  }

  const checks = await database.query(`
    SELECT pg_get_constraintdef(constraint_record.oid, true) AS "definition"
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = 'public.infrastructure_smoke_probe'::regclass
      AND constraint_record.contype = 'c'
    ORDER BY constraint_record.oid
  `);
  if (
    checks.rows.length !== 1 ||
    !/^CHECK \(probe_key = 'mobile-server-database-v1'::text\)$/.test(
      checks.rows[0].definition,
    )
  ) {
    throw new Error(
      'Migration verification failed: incompatible fixed-key check',
    );
  }

  const security = await database.query(`
    SELECT
      class_record.relrowsecurity AS "rlsEnabled",
      count(policy_record.oid)::int AS "policyCount"
    FROM pg_class class_record
    LEFT JOIN pg_policy policy_record
      ON policy_record.polrelid = class_record.oid
    WHERE class_record.oid = 'public.infrastructure_smoke_probe'::regclass
    GROUP BY class_record.relrowsecurity
  `);
  const securityRow = security.rows[0];

  if (
    security.rows.length !== 1 ||
    securityRow?.rlsEnabled !== true ||
    securityRow.policyCount !== 0
  ) {
    throw new Error('Migration verification failed: incompatible row security');
  }
}
