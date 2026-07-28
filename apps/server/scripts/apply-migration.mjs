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

  const constraints = await database.query(`
    SELECT
      constraint_record.contype AS "constraintType",
      pg_get_constraintdef(constraint_record.oid, true) AS "definition",
      COALESCE(
        array_agg(attribute.attname ORDER BY key_column.ordinality)
          FILTER (WHERE attribute.attname IS NOT NULL),
        ARRAY[]::name[]
      ) AS "columns"
    FROM pg_constraint constraint_record
    LEFT JOIN unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
      ON true
    LEFT JOIN pg_attribute attribute
      ON attribute.attrelid = constraint_record.conrelid
      AND attribute.attnum = key_column.attnum
    WHERE constraint_record.conrelid = 'public.infrastructure_smoke_probe'::regclass
    GROUP BY constraint_record.oid, constraint_record.contype
    ORDER BY constraint_record.contype, "definition"
  `);

  const primaryKeys = constraints.rows.filter(
    ({ constraintType }) => constraintType === 'p',
  );
  if (
    constraints.rows.length !== 2 ||
    primaryKeys.length !== 1 ||
    JSON.stringify(primaryKeys[0].columns) !== JSON.stringify(['probe_key']) ||
    primaryKeys[0].definition !== 'PRIMARY KEY (probe_key)'
  ) {
    throw new Error('Migration verification failed: incompatible primary key');
  }

  const checks = constraints.rows.filter(
    ({ constraintType }) => constraintType === 'c',
  );
  if (
    checks.length !== 1 ||
    !/^CHECK \(probe_key = 'mobile-server-database-v1'::text\)$/.test(
      checks[0].definition,
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
