import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';

import { readConfig } from '../dist/config.js';
import {
  INFRASTRUCTURE_SMOKE_PROBE_KEY,
  createPostgresDatabase,
} from '../dist/database.js';

const config = readConfig(process.env, process.cwd());
const database = createPostgresDatabase(config.database);
const first = {
  commandId: randomUUID(),
  probeToken: randomUUID(),
};
const second = {
  commandId: randomUUID(),
  probeToken: randomUUID(),
};

try {
  await database.check();
  const firstReadback = await database.runInfrastructureSmoke(first);
  const secondReadback = await database.runInfrastructureSmoke(second);

  assertReadback(firstReadback, first, 'first');
  assertReadback(secondReadback, second, 'second');

  const ca = await readFile(config.database.caPath, 'utf8');
  const pool = new Pool({
    application_name: 'guandan-smoke-verification',
    connectionString: config.database.connectionString,
    max: 1,
    ssl: { ca, rejectUnauthorized: true },
  });

  try {
    const retainedResult = await pool.query(
      `
        SELECT
          probe_key AS "probeKey",
          last_command_id::text AS "commandId",
          last_probe_token::text AS "probeToken",
          updated_at AS "databaseUpdatedAt",
          count(*) OVER ()::int AS "rowCount"
        FROM public.infrastructure_smoke_probe
      `,
    );
    const retained = retainedResult.rows[0];

    if (
      retainedResult.rowCount !== 1 ||
      retained?.rowCount !== 1 ||
      retained.probeKey !== INFRASTRUCTURE_SMOKE_PROBE_KEY ||
      retained.commandId !== second.commandId ||
      retained.probeToken !== second.probeToken ||
      !(retained.databaseUpdatedAt instanceof Date) ||
      Number.isNaN(retained.databaseUpdatedAt.getTime()) ||
      retained.databaseUpdatedAt.getTime() !==
        secondReadback.databaseUpdatedAt.getTime()
    ) {
      throw new Error('Retention verification failed');
    }

    console.log('Real database smoke verification passed');
    console.log(`probeKey=${retained.probeKey}`);
    console.log(
      `first commandId=${first.commandId} probeToken=${first.probeToken} databaseUpdatedAt=${firstReadback.databaseUpdatedAt.toISOString()}`,
    );
    console.log(
      `second commandId=${second.commandId} probeToken=${second.probeToken} databaseUpdatedAt=${secondReadback.databaseUpdatedAt.toISOString()}`,
    );
    console.log(`retainedRowCount=${retained.rowCount}`);
  } finally {
    await pool.end();
  }
} finally {
  await database.close();
}

function assertReadback(readback, command, label) {
  if (
    readback.commandId !== command.commandId ||
    readback.probeToken !== command.probeToken ||
    !(readback.databaseUpdatedAt instanceof Date) ||
    Number.isNaN(readback.databaseUpdatedAt.getTime())
  ) {
    throw new Error(`${label} database readback verification failed`);
  }
}
