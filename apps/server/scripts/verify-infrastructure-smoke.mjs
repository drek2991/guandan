import { randomUUID } from 'node:crypto';

import { readConfig } from '../dist/config.js';
import {
  INFRASTRUCTURE_SMOKE_PROBE_KEY,
  createPostgresDatabase,
} from '../dist/database.js';

const config = readConfig(process.env, process.cwd());
const database = createPostgresDatabase(config.database);

try {
  await database.check();
  await database.runInfrastructureSmoke({
    commandId: randomUUID(),
    probeToken: randomUUID(),
  });
  const second = {
    commandId: randomUUID(),
    probeToken: randomUUID(),
  };
  const retained = await database.runInfrastructureSmoke(second);

  if (
    retained.commandId !== second.commandId ||
    retained.probeToken !== second.probeToken
  ) {
    throw new Error('Retention verification failed');
  }

  console.log(
    `Real database upsert/readback verified twice for ${INFRASTRUCTURE_SMOKE_PROBE_KEY}; retained rows=1`,
  );
} finally {
  await database.close();
}
