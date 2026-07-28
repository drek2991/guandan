import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
  SCAFFOLD_PING_EVENT,
  type InfrastructureDatabaseSmokeAcknowledgement,
  type ScaffoldClientToServerEvents,
  type ScaffoldPingResponse,
  type ScaffoldServerToClientEvents,
} from '@guandan/protocol';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import request from 'supertest';

import { createApp } from '../src/app.js';
import {
  InfrastructureSmokeDatabaseError,
  type Database,
} from '../src/database.js';
import { createGuandanServer } from '../src/server.js';
import { startServer, type RunningServer } from '../src/start.js';

const READY_ERROR_MARKER = 'database-detail-marker';
const COMMAND = {
  commandId: '550e8400-e29b-41d4-a716-446655440000',
  probeToken: '8f14e45f-ea1e-4b29-bad7-6e7f5f541234',
};
const DATABASE_UPDATED_AT = new Date('2026-07-27T12:00:00.000Z');

function createFakeDatabase(options?: {
  checkError?: Error;
  onCheck?: () => void;
  onClose?: () => void;
  onInfrastructureSmoke?: () => void;
  smokeError?: Error;
}): Database {
  return {
    async check(): Promise<void> {
      options?.onCheck?.();
      if (options?.checkError !== undefined) {
        throw options.checkError;
      }
    },
    async runInfrastructureSmoke(command) {
      options?.onInfrastructureSmoke?.();
      if (options?.smokeError !== undefined) {
        throw options.smokeError;
      }
      return {
        ...command,
        databaseUpdatedAt: DATABASE_UPDATED_AT,
      };
    },
    async close(): Promise<void> {
      options?.onClose?.();
    },
  };
}

describe('HTTP scaffold', () => {
  it('returns stable service information from GET /health without checking the database', async () => {
    let checkCalls = 0;
    const app = createApp(
      createFakeDatabase({
        checkError: new Error(READY_ERROR_MARKER),
        onCheck: () => {
          checkCalls += 1;
        },
      }),
    );
    const response = await request(app).get('/health').expect(200);

    assert.deepEqual(response.body, {
      status: 'healthy',
      service: 'guandan-server',
    });
    assert.equal(checkCalls, 0);
  });

  it('returns HTTP 200 when the database is ready', async () => {
    const app = createApp(createFakeDatabase());
    const response = await request(app).get('/ready').expect(200);

    assert.deepEqual(response.body, {
      status: 'ready',
      service: 'guandan-server',
    });
  });

  it('returns a sanitized HTTP 503 when the database is not ready', async () => {
    const app = createApp(
      createFakeDatabase({
        checkError: new Error(READY_ERROR_MARKER),
      }),
    );
    const response = await request(app).get('/ready').expect(503);

    assert.deepEqual(response.body, {
      status: 'not_ready',
      service: 'guandan-server',
    });
    assert.equal(response.text.includes(READY_ERROR_MARKER), false);
  });

  it('returns a controlled JSON response for unknown routes', async () => {
    const app = createApp(createFakeDatabase());
    const response = await request(app).get('/missing').expect(404);

    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    assert.deepEqual(response.body, {
      error: 'not_found',
    });
  });

  it('does not expose stack traces in unexpected HTTP error responses', async () => {
    const app = createApp(createFakeDatabase());
    const response = await request(app)
      .post('/health')
      .set('content-type', 'application/json')
      .send('{')
      .expect(500);

    assert.deepEqual(response.body, {
      error: 'internal_server_error',
    });
    assert.equal(response.text.includes('SyntaxError'), false);
  });
});

describe('Socket.IO scaffold', () => {
  let runningServer: RunningServer;
  let client: Socket<
    ScaffoldServerToClientEvents,
    ScaffoldClientToServerEvents
  >;

  before(async () => {
    const database = createFakeDatabase();
    runningServer = await startServer(
      {
        database: {
          caPath: 'test-ca.crt',
          connectionString: 'test-configuration',
        },
        host: '127.0.0.1',
        port: 0,
      },
      {
        createDatabase: () => database,
        createServer: createGuandanServer,
      },
    );

    client = createSocketClient(
      `http://127.0.0.1:${runningServer.address.port}`,
      {
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
      },
    );

    await waitForConnection(client);
  });

  after(async () => {
    client.disconnect();
    await runningServer.close();
  });

  it('connects and acknowledges the scaffold connectivity event', async () => {
    const response = await waitForAcknowledgement(client);

    assert.deepEqual(response, {
      status: 'ok',
    });
  });

  it('returns success after the database verifies a valid smoke command', async () => {
    const response = await waitForSmokeAcknowledgement(client, COMMAND);

    assert.equal(response.status, 'ok');
    if (response.status === 'ok') {
      assert.deepEqual(
        {
          commandId: response.commandId,
          probeToken: response.probeToken,
          databaseVerified: response.databaseVerified,
          operation: response.operation,
          databaseUpdatedAt: response.databaseUpdatedAt,
        },
        {
          ...COMMAND,
          databaseVerified: true,
          operation: 'upsert-readback',
          databaseUpdatedAt: DATABASE_UPDATED_AT.toISOString(),
        },
      );
      assert.equal(Number.isFinite(Date.parse(response.completedAt)), true);
    }
  });
});

describe('Socket.IO database smoke failures', () => {
  it('rejects invalid payloads before calling the database', async () => {
    let databaseCalls = 0;
    const { client, close } = await startSocketTest(
      createFakeDatabase({
        onInfrastructureSmoke: () => {
          databaseCalls += 1;
        },
      }),
    );

    try {
      const response = await waitForSmokeAcknowledgement(client, {
        commandId: COMMAND.commandId,
        probeToken: 'invalid',
      });
      assert.deepEqual(response, {
        status: 'error',
        code: 'INVALID_PAYLOAD',
        message: 'Invalid smoke command payload',
        commandId: COMMAND.commandId,
      });
      assert.equal(databaseCalls, 0);

      const responseWithoutValidCommandId = await waitForSmokeAcknowledgement(
        client,
        {
          commandId: 'invalid',
          probeToken: COMMAND.probeToken,
        },
      );
      assert.deepEqual(responseWithoutValidCommandId, {
        status: 'error',
        code: 'INVALID_PAYLOAD',
        message: 'Invalid smoke command payload',
      });
      assert.equal(databaseCalls, 0);
    } finally {
      await close();
    }
  });

  for (const [failure, code] of [
    ['unavailable', 'DATABASE_UNAVAILABLE'],
    ['write', 'DATABASE_WRITE_FAILED'],
    ['readback-mismatch', 'DATABASE_READBACK_MISMATCH'],
    ['internal', 'INTERNAL_ERROR'],
  ] as const) {
    it(`maps ${failure} database failures to ${code}`, async () => {
      const { client, close } = await startSocketTest(
        createFakeDatabase({
          smokeError: new InfrastructureSmokeDatabaseError(failure),
        }),
      );

      try {
        const response = await waitForSmokeAcknowledgement(client, COMMAND);
        assert.equal(response.status, 'error');
        if (response.status === 'error') {
          assert.equal(response.code, code);
          assert.equal(response.commandId, COMMAND.commandId);
          assert.equal(response.message.includes(READY_ERROR_MARKER), false);
        }
      } finally {
        await close();
      }
    });
  }

  it('maps unexpected failures to INTERNAL_ERROR without crashing', async () => {
    const { client, close } = await startSocketTest(
      createFakeDatabase({
        smokeError: new Error(READY_ERROR_MARKER),
      }),
    );

    try {
      const response = await waitForSmokeAcknowledgement(client, COMMAND);
      assert.deepEqual(response, {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Smoke operation failed',
        commandId: COMMAND.commandId,
      });
      assert.equal(response.message.includes(READY_ERROR_MARKER), false);
      assert.deepEqual(await waitForAcknowledgement(client), { status: 'ok' });
    } finally {
      await close();
    }
  });
});

async function startSocketTest(database: Database): Promise<{
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>;
  close: () => Promise<void>;
}> {
  const runningServer = await startServer(
    {
      database: {
        caPath: 'test-ca.crt',
        connectionString: 'test-configuration',
      },
      host: '127.0.0.1',
      port: 0,
    },
    {
      createDatabase: () => database,
      createServer: createGuandanServer,
    },
  );
  const client = createSocketClient(
    `http://127.0.0.1:${runningServer.address.port}`,
    {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    },
  );
  await waitForConnection(client);

  return {
    client,
    async close(): Promise<void> {
      client.disconnect();
      await runningServer.close();
    },
  };
}

function waitForSmokeAcknowledgement(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
  payload: unknown,
): Promise<InfrastructureDatabaseSmokeAcknowledgement> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO smoke acknowledgement timed out'));
    }, 5_000);

    client.emit(INFRASTRUCTURE_DATABASE_SMOKE_EVENT, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForAcknowledgement(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
): Promise<ScaffoldPingResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO acknowledgement timed out'));
    }, 5_000);

    client.emit(SCAFFOLD_PING_EVENT, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForConnection(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO client connection timed out'));
    }, 5_000);

    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
