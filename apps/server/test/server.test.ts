import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
  LOBBY_CREATE_ROOM_EVENT,
  SCAFFOLD_PING_EVENT,
  type CreateRoomAcknowledgement,
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
import type { LobbyRuntime } from '../src/lobby/runtime.js';
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

describe('Socket.IO create-room integration', () => {
  it('returns structured success and replays an identical command', async () => {
    const { client, close } = await startSocketTest(createFakeDatabase());
    const command = {
      commandId: '11111111-1111-4111-8111-111111111111',
      displayName: '  Ａｌｅｘ  ',
      settings: { startingLevel: 2, turnTimer: 'off' },
    };

    try {
      const first = await waitForCreateRoomAcknowledgement(client, command);
      assert.equal(first.status, 'ok');
      if (first.status === 'ok') {
        assert.equal(first.commandId, command.commandId);
        assert.equal(first.roomRevision, 0);
        assert.equal(first.snapshot.players[0]?.displayName, 'Alex');
        assert.equal(first.snapshot.players.length, 1);
      }
      const retry = await waitForCreateRoomAcknowledgement(client, command);
      assert.deepEqual(retry, first);
      assert.deepEqual(await waitForAcknowledgement(client), { status: 'ok' });
    } finally {
      await close();
    }
  });

  it('rejects invalid payload, command conflict, and an already-bound new command', async () => {
    const { client, close } = await startSocketTest(createFakeDatabase());
    const command = {
      commandId: '22222222-2222-4222-8222-222222222222',
      displayName: 'Alex',
      settings: { startingLevel: 2, turnTimer: 30 },
    };

    try {
      assert.deepEqual(
        await waitForCreateRoomAcknowledgement(client, {
          ...command,
          roomId: '33333333-3333-4333-8333-333333333333',
        }),
        {
          status: 'error',
          code: 'INVALID_PAYLOAD',
          message: 'Invalid create-room command payload',
          commandId: command.commandId,
        },
      );
      assert.equal(
        (await waitForCreateRoomAcknowledgement(client, command)).status,
        'ok',
      );
      const conflict = await waitForCreateRoomAcknowledgement(client, {
        ...command,
        displayName: 'Blair',
      });
      assert.equal(conflict.status, 'error');
      if (conflict.status === 'error') {
        assert.equal(conflict.code, 'COMMAND_ID_CONFLICT');
      }
      const alreadyBound = await waitForCreateRoomAcknowledgement(client, {
        ...command,
        commandId: '33333333-3333-4333-8333-333333333333',
      });
      assert.equal(alreadyBound.status, 'error');
      if (alreadyBound.status === 'error') {
        assert.equal(alreadyBound.code, 'ALREADY_IN_ROOM');
      }
    } finally {
      await close();
    }
  });

  it('creates isolated rooms for two different sockets without broadcasting', async () => {
    const database = createFakeDatabase();
    const runningServer = await startServer(
      {
        database: {
          caPath: 'test-ca.crt',
          connectionString: 'test-configuration',
        },
        host: '127.0.0.1',
        port: 0,
      },
      { createDatabase: () => database, createServer: createGuandanServer },
    );
    const first = createSocketClient(
      `http://127.0.0.1:${runningServer.address.port}`,
      { forceNew: true, reconnection: false, transports: ['websocket'] },
    );
    const second = createSocketClient(
      `http://127.0.0.1:${runningServer.address.port}`,
      { forceNew: true, reconnection: false, transports: ['websocket'] },
    );
    let unsolicitedEvents = 0;
    first.onAny((event) => {
      if (event !== 'connect') {
        unsolicitedEvents += 1;
      }
    });

    try {
      await Promise.all([waitForConnection(first), waitForConnection(second)]);
      const firstResult = await waitForCreateRoomAcknowledgement(first, {
        commandId: '44444444-4444-4444-8444-444444444444',
        displayName: 'Alex',
        settings: { startingLevel: 2, turnTimer: 'off' },
      });
      const secondResult = await waitForCreateRoomAcknowledgement(second, {
        commandId: '55555555-5555-4555-8555-555555555555',
        displayName: 'Blair',
        settings: { startingLevel: 7, turnTimer: 60 },
      });
      assert.equal(firstResult.status, 'ok');
      assert.equal(secondResult.status, 'ok');
      if (firstResult.status === 'ok' && secondResult.status === 'ok') {
        assert.notEqual(
          firstResult.snapshot.roomId,
          secondResult.snapshot.roomId,
        );
        assert.notEqual(
          firstResult.snapshot.roomCode,
          secondResult.snapshot.roomCode,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(unsolicitedEvents, 0);
    } finally {
      first.disconnect();
      second.disconnect();
      await runningServer.close();
    }
  });

  it('survives a create-room runtime failure and keeps existing handlers functional', async () => {
    const failingRuntime: LobbyRuntime = {
      createRoom: () => {
        throw new Error(READY_ERROR_MARKER);
      },
    };
    const { client, close } = await startSocketTest(
      createFakeDatabase(),
      failingRuntime,
    );
    const command = {
      commandId: '66666666-6666-4666-8666-666666666666',
      displayName: 'Alex',
      settings: { startingLevel: 2, turnTimer: 'off' },
    };

    try {
      const response = await waitForCreateRoomAcknowledgement(client, command);
      assert.deepEqual(response, {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Room creation failed',
        commandId: command.commandId,
      });
      assert.equal(response.message.includes(READY_ERROR_MARKER), false);
      assert.deepEqual(await waitForAcknowledgement(client), { status: 'ok' });
      const smoke = await waitForSmokeAcknowledgement(client, COMMAND);
      assert.equal(smoke.status, 'ok');
    } finally {
      await close();
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

async function startSocketTest(
  database: Database,
  lobbyRuntime?: LobbyRuntime,
): Promise<{
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
      createServer: (createdDatabase) =>
        createGuandanServer(createdDatabase, lobbyRuntime),
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

function waitForCreateRoomAcknowledgement(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
  payload: unknown,
): Promise<CreateRoomAcknowledgement> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO create-room acknowledgement timed out'));
    }, 5_000);

    client.emit(LOBBY_CREATE_ROOM_EVENT, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
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
