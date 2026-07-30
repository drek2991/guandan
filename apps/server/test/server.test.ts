import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
  LOBBY_CREATE_ROOM_EVENT,
  LOBBY_JOIN_ROOM_EVENT,
  LOBBY_SNAPSHOT_EVENT,
  SCAFFOLD_PING_EVENT,
  parseLobbySnapshotV1,
  type CreateRoomAcknowledgement,
  type InfrastructureDatabaseSmokeAcknowledgement,
  type JoinRoomAcknowledgement,
  type LobbySnapshotV1,
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
import { createLobbyRuntime, type LobbyRuntime } from '../src/lobby/runtime.js';
import { createGuandanServer, type GuandanServer } from '../src/server.js';
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
  it('joins the UUID channel, delivers before acknowledgement, and replays exactly', async () => {
    const { client, server, close } =
      await startSocketTest(createFakeDatabase());
    const command = {
      commandId: '11111111-1111-4111-8111-111111111111',
      displayName: '  Ａｌｅｘ  ',
      settings: { startingLevel: 2, turnTimer: 'off' },
    };
    const trace: string[] = [];
    const snapshots: LobbySnapshotV1[] = [];
    client.on(LOBBY_SNAPSHOT_EVENT, (snapshot) => {
      snapshots.push(snapshot);
      trace.push(`snapshot:${snapshot.revision}`);
    });

    try {
      const first = await waitForCreateRoomAcknowledgement(
        client,
        command,
        () => trace.push('ack:0'),
      );
      assert.equal(first.status, 'ok');
      if (first.status === 'ok') {
        assert.equal(first.commandId, command.commandId);
        assert.equal(first.roomRevision, 0);
        assert.equal(first.snapshot.players[0]?.displayName, 'Alex');
        assert.equal(first.snapshot.players.length, 1);
        assert.deepEqual(trace, ['snapshot:0', 'ack:0']);
        assert.deepEqual(parseLobbySnapshotV1(snapshots[0]), snapshots[0]);
        const serverSocket = server.io.sockets.sockets.get(client.id!);
        assert.notEqual(serverSocket, undefined);
        assert.equal(serverSocket!.rooms.has(first.snapshot.roomId), true);
        assert.equal(serverSocket!.rooms.has(first.snapshot.roomCode), false);
      }
      const retry = await waitForCreateRoomAcknowledgement(client, command);
      assert.deepEqual(retry, first);
      await waitForCondition(() => snapshots.length === 2);
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.revision),
        [0, 0],
      );
      assert.deepEqual(await waitForAcknowledgement(client), { status: 'ok' });
    } finally {
      await close();
    }
  });

  it('returns stale create replay before the latest authoritative snapshot', async () => {
    const { clients, close } = await startMultiClientTest(2);
    const [creator, joiner] = clients;
    const createCommand = {
      commandId: '12121212-1212-4212-8212-121212121212',
      displayName: 'Alex',
      settings: { startingLevel: 2, turnTimer: 'off' },
    };
    const trace: string[] = [];
    const creatorSnapshots: LobbySnapshotV1[] = [];
    creator!.on(LOBBY_SNAPSHOT_EVENT, (snapshot) => {
      creatorSnapshots.push(snapshot);
      trace.push(`snapshot:${snapshot.revision}`);
    });

    try {
      const original = await waitForCreateRoomAcknowledgement(
        creator!,
        createCommand,
      );
      assert.equal(original.status, 'ok');
      if (original.status !== 'ok') return;
      const joined = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: '13131313-1313-4313-8313-131313131313',
        roomCode: original.snapshot.roomCode,
        displayName: 'Blair',
      });
      assert.equal(joined.status, 'ok');
      await waitForCondition(() => creatorSnapshots.length === 2);

      trace.length = 0;
      const replay = await waitForCreateRoomAcknowledgement(
        creator!,
        createCommand,
        (response) =>
          trace.push(
            `ack:${response.status === 'ok' ? response.roomRevision : 'error'}`,
          ),
      );
      assert.deepEqual(replay, original);
      await waitForCondition(() => creatorSnapshots.length === 3);
      assert.deepEqual(trace, ['ack:0', 'snapshot:1']);
      assert.equal(creatorSnapshots[2]?.revision, 1);
      assert.equal(creatorSnapshots[2]?.players.length, 2);
      assert.equal(joined.status === 'ok' ? joined.roomRevision : undefined, 1);

      const newCommand = await waitForCreateRoomAcknowledgement(creator!, {
        ...createCommand,
        commandId: '14141414-1414-4414-8414-141414141414',
      });
      assert.equal(newCommand.status, 'error');
      if (newCommand.status === 'error') {
        assert.equal(newCommand.code, 'ALREADY_IN_ROOM');
      }
    } finally {
      await close();
    }
  });

  it('preserves committed state and receipt when transport planning fails', async () => {
    const baseRuntime = createLobbyRuntime();
    let failPlanning = true;
    const runtime: LobbyRuntime = {
      ...baseRuntime,
      prepareLobbySnapshotDeliveries: (roomId) => {
        if (failPlanning) throw new Error(READY_ERROR_MARKER);
        return baseRuntime.prepareLobbySnapshotDeliveries(roomId);
      },
    };
    const { client, server, close } = await startSocketTest(
      createFakeDatabase(),
      runtime,
    );
    const command = {
      commandId: '15151515-1515-4515-8515-151515151515',
      displayName: 'Alex',
      settings: { startingLevel: 7, turnTimer: 60 },
    };
    const snapshots: LobbySnapshotV1[] = [];
    client.on(LOBBY_SNAPSHOT_EVENT, (snapshot) => snapshots.push(snapshot));

    try {
      const failure = await waitForCreateRoomAcknowledgement(client, command);
      assert.equal(failure.status, 'error');
      if (failure.status === 'error') {
        assert.equal(failure.code, 'INTERNAL_ERROR');
        assert.equal(failure.message.includes(READY_ERROR_MARKER), false);
      }
      assert.equal(snapshots.length, 0);
      const socket = server.io.sockets.sockets.get(client.id!);
      assert.notEqual(socket, undefined);
      assert.equal(socket!.rooms.size, 1);

      const newCommand = await waitForCreateRoomAcknowledgement(client, {
        ...command,
        commandId: '16161616-1616-4616-8616-161616161616',
      });
      assert.equal(newCommand.status, 'error');
      if (newCommand.status === 'error') {
        assert.equal(newCommand.code, 'ALREADY_IN_ROOM');
      }

      failPlanning = false;
      const recovered = await waitForCreateRoomAcknowledgement(client, command);
      assert.equal(recovered.status, 'ok');
      if (recovered.status === 'ok') {
        assert.equal(recovered.roomRevision, 0);
        assert.equal(recovered.snapshot.players.length, 1);
        assert.equal(socket!.rooms.has(recovered.snapshot.roomId), true);
      }
      await waitForCondition(() => snapshots.length === 1);
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

  it('creates isolated rooms and delivers only player-specific snapshots', async () => {
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
    const first: Socket<
      ScaffoldServerToClientEvents,
      ScaffoldClientToServerEvents
    > = createSocketClient(`http://127.0.0.1:${runningServer.address.port}`, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    });
    const second: Socket<
      ScaffoldServerToClientEvents,
      ScaffoldClientToServerEvents
    > = createSocketClient(`http://127.0.0.1:${runningServer.address.port}`, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    });
    const firstSnapshots: LobbySnapshotV1[] = [];
    const secondSnapshots: LobbySnapshotV1[] = [];
    first.on(LOBBY_SNAPSHOT_EVENT, (snapshot) => firstSnapshots.push(snapshot));
    second.on(LOBBY_SNAPSHOT_EVENT, (snapshot) =>
      secondSnapshots.push(snapshot),
    );

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
      await waitForCondition(
        () => firstSnapshots.length === 1 && secondSnapshots.length === 1,
      );
      assert.equal(
        firstSnapshots[0]?.roomId,
        firstResult.status === 'ok' ? firstResult.snapshot.roomId : undefined,
      );
      assert.equal(
        secondSnapshots[0]?.roomId,
        secondResult.status === 'ok' ? secondResult.snapshot.roomId : undefined,
      );
      assert.notEqual(firstSnapshots[0]?.roomId, secondSnapshots[0]?.roomId);
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
      joinRoom: () => ({
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Room join failed',
      }),
      prepareLobbySnapshotDeliveries: () => {
        throw new Error('Transport planning should not run');
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

describe('Socket.IO join-room integration', () => {
  it('delivers individualized same-revision snapshots and replays exactly', async () => {
    const { runningServer, server, clients, close } =
      await startMultiClientTest(2);
    const [creator, joiner] = clients;
    assert.notEqual(creator, undefined);
    assert.notEqual(joiner, undefined);
    const creatorSnapshots: LobbySnapshotV1[] = [];
    const joinerSnapshots: LobbySnapshotV1[] = [];
    creator!.on(LOBBY_SNAPSHOT_EVENT, (snapshot) =>
      creatorSnapshots.push(snapshot),
    );
    joiner!.on(LOBBY_SNAPSHOT_EVENT, (snapshot) =>
      joinerSnapshots.push(snapshot),
    );
    try {
      const created = await waitForCreateRoomAcknowledgement(creator!, {
        commandId: '77777777-7777-4777-8777-777777777777',
        displayName: 'Alex',
        settings: { startingLevel: 2, turnTimer: 'off' },
      });
      assert.equal(created.status, 'ok');
      if (created.status !== 'ok') return;
      const creatorSocket = server.io.sockets.sockets.get(creator!.id!);
      assert.notEqual(creatorSocket, undefined);
      await creatorSocket!.leave(created.snapshot.roomId);
      assert.equal(creatorSocket!.rooms.has(created.snapshot.roomId), false);
      const command = {
        commandId: '88888888-8888-4888-8888-888888888888',
        roomCode: created.snapshot.roomCode,
        displayName: '  Ｂｌａｉｒ  ',
      };
      const first = await waitForJoinRoomAcknowledgement(joiner!, command);
      assert.equal(first.status, 'ok');
      if (first.status === 'ok') {
        assert.equal(first.roomRevision, 1);
        assert.equal(first.snapshot.players.length, 2);
        assert.equal(first.snapshot.players[1]?.displayName, 'Blair');
        assert.equal(
          first.snapshot.selfPlayerId === first.snapshot.hostPlayerId,
          false,
        );
        const joinerSocket = server.io.sockets.sockets.get(joiner!.id!);
        assert.notEqual(joinerSocket, undefined);
        assert.equal(joinerSocket!.rooms.has(first.snapshot.roomId), true);
        assert.equal(joinerSocket!.rooms.has(first.snapshot.roomCode), false);
      }
      await waitForCondition(
        () => creatorSnapshots.length === 2 && joinerSnapshots.length === 1,
      );
      assert.equal(creatorSnapshots[1]?.revision, 1);
      assert.equal(joinerSnapshots[0]?.revision, 1);
      assert.equal(creatorSocket!.rooms.has(created.snapshot.roomId), false);
      assert.equal(
        creatorSnapshots[1]?.selfPlayerId,
        created.snapshot.selfPlayerId,
      );
      assert.equal(
        joinerSnapshots[0]?.selfPlayerId,
        first.status === 'ok' ? first.snapshot.selfPlayerId : undefined,
      );
      assert.notEqual(
        creatorSnapshots[1]?.selfPlayerId,
        joinerSnapshots[0]?.selfPlayerId,
      );
      assert.equal(creatorSnapshots[1]?.capabilities.canChangeSettings, true);
      assert.equal(joinerSnapshots[0]?.capabilities.canChangeSettings, false);
      const replay = await waitForJoinRoomAcknowledgement(joiner!, command);
      assert.deepEqual(replay, first);
      await waitForCondition(
        () => creatorSnapshots.length === 3 && joinerSnapshots.length === 2,
      );
      assert.deepEqual(await waitForAcknowledgement(creator!), {
        status: 'ok',
      });
      assert.deepEqual(await waitForAcknowledgement(joiner!), { status: 'ok' });
      assert.notEqual(runningServer.address.port, 0);
    } finally {
      await close();
    }
  });

  it('returns stale join replay before the latest authoritative snapshot', async () => {
    const { clients, close } = await startMultiClientTest(3);
    const [creator, firstJoiner, laterJoiner] = clients;
    const trace: string[] = [];
    const firstJoinerSnapshots: LobbySnapshotV1[] = [];
    firstJoiner!.on(LOBBY_SNAPSHOT_EVENT, (snapshot) => {
      firstJoinerSnapshots.push(snapshot);
      trace.push(`snapshot:${snapshot.revision}`);
    });

    try {
      const created = await waitForCreateRoomAcknowledgement(creator!, {
        commandId: '17171717-1717-4717-8717-171717171717',
        displayName: 'Alex',
        settings: { startingLevel: 2, turnTimer: 30 },
      });
      assert.equal(created.status, 'ok');
      if (created.status !== 'ok') return;
      const command = {
        commandId: '18181818-1818-4818-8818-181818181818',
        roomCode: created.snapshot.roomCode,
        displayName: 'Blair',
      };
      const original = await waitForJoinRoomAcknowledgement(
        firstJoiner!,
        command,
      );
      assert.equal(original.status, 'ok');
      const later = await waitForJoinRoomAcknowledgement(laterJoiner!, {
        commandId: '19191919-1919-4919-8919-191919191919',
        roomCode: created.snapshot.roomCode,
        displayName: 'Casey',
      });
      assert.equal(later.status, 'ok');
      await waitForCondition(() => firstJoinerSnapshots.length === 2);

      trace.length = 0;
      const replay = await waitForJoinRoomAcknowledgement(
        firstJoiner!,
        command,
        (response) =>
          trace.push(
            `ack:${response.status === 'ok' ? response.roomRevision : 'error'}`,
          ),
      );
      assert.deepEqual(replay, original);
      await waitForCondition(() => firstJoinerSnapshots.length === 3);
      assert.deepEqual(trace, ['ack:1', 'snapshot:2']);
      assert.equal(firstJoinerSnapshots[2]?.revision, 2);
      assert.equal(firstJoinerSnapshots[2]?.players.length, 3);
      assert.equal(later.status === 'ok' ? later.roomRevision : undefined, 2);

      const newCommand = await waitForJoinRoomAcknowledgement(firstJoiner!, {
        ...command,
        commandId: '20212120-2121-4021-8021-202121202121',
      });
      assert.equal(newCommand.status, 'error');
      if (newCommand.status === 'error') {
        assert.equal(newCommand.code, 'ALREADY_IN_ROOM');
      }
    } finally {
      await close();
    }
  });

  it('returns join errors without crashing or broadcasting', async () => {
    const { clients, close } = await startMultiClientTest(3);
    const [creator, joiner, other] = clients;
    assert.notEqual(creator, undefined);
    assert.notEqual(joiner, undefined);
    assert.notEqual(other, undefined);
    const creatorSnapshots: LobbySnapshotV1[] = [];
    creator!.on(LOBBY_SNAPSHOT_EVENT, (snapshot) =>
      creatorSnapshots.push(snapshot),
    );
    try {
      const invalid = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: '99999999-9999-4999-8999-999999999999',
        roomCode: 'invalid',
        displayName: 'Blair',
      });
      assert.equal(invalid.status, 'error');
      if (invalid.status === 'error')
        assert.equal(invalid.code, 'INVALID_PAYLOAD');
      const missing = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        roomCode: 'ABC234',
        displayName: 'Blair',
      });
      assert.equal(missing.status, 'error');
      if (missing.status === 'error')
        assert.equal(missing.code, 'ROOM_NOT_FOUND');

      const created = await waitForCreateRoomAcknowledgement(creator!, {
        commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        displayName: 'Alex',
        settings: { startingLevel: 7, turnTimer: 60 },
      });
      assert.equal(created.status, 'ok');
      if (created.status !== 'ok') return;
      const taken = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        roomCode: created.snapshot.roomCode,
        displayName: 'Ａｌｅｘ',
      });
      assert.equal(taken.status, 'error');
      if (taken.status === 'error') assert.equal(taken.code, 'NAME_TAKEN');
      const joined = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        roomCode: created.snapshot.roomCode,
        displayName: 'Blair',
      });
      assert.equal(joined.status, 'ok');
      const payloadConflict = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        roomCode: created.snapshot.roomCode,
        displayName: 'Changed',
      });
      assert.equal(payloadConflict.status, 'error');
      if (payloadConflict.status === 'error') {
        assert.equal(payloadConflict.code, 'COMMAND_ID_CONFLICT');
      }
      const conflict = await waitForJoinRoomAcknowledgement(other!, {
        commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        roomCode: created.snapshot.roomCode,
        displayName: 'Blair',
      });
      assert.equal(conflict.status, 'error');
      if (conflict.status === 'error')
        assert.equal(conflict.code, 'COMMAND_ID_CONFLICT');
      const bound = await waitForJoinRoomAcknowledgement(joiner!, {
        commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        roomCode: created.snapshot.roomCode,
        displayName: 'Casey',
      });
      assert.equal(bound.status, 'error');
      if (bound.status === 'error') assert.equal(bound.code, 'ALREADY_IN_ROOM');
      await waitForCondition(() => creatorSnapshots.length === 2);
      assert.deepEqual(
        creatorSnapshots.map((snapshot) => snapshot.revision),
        [0, 1],
      );
      assert.equal(
        (await waitForSmokeAcknowledgement(other!, COMMAND)).status,
        'ok',
      );
    } finally {
      await close();
    }
  });

  it('fills a room to four and keeps a second room isolated', async () => {
    const { clients, close } = await startMultiClientTest(6);
    const [creator, one, two, three, extra, secondCreator] = clients;
    try {
      const created = await waitForCreateRoomAcknowledgement(creator!, {
        commandId: '10101010-1010-4010-8010-101010101010',
        displayName: 'Alex',
        settings: { startingLevel: 2, turnTimer: 30 },
      });
      const secondRoom = await waitForCreateRoomAcknowledgement(
        secondCreator!,
        {
          commandId: '20202020-2020-4020-8020-202020202020',
          displayName: 'Emery',
          settings: { startingLevel: 7, turnTimer: 'off' },
        },
      );
      assert.equal(created.status, 'ok');
      assert.equal(secondRoom.status, 'ok');
      if (created.status !== 'ok' || secondRoom.status !== 'ok') return;
      for (const [client, id, name] of [
        [one!, '30303030-3030-4030-8030-303030303030', 'Blair'],
        [two!, '40404040-4040-4040-8040-404040404040', 'Casey'],
        [three!, '50505050-5050-4050-8050-505050505050', 'Devon'],
      ] as const) {
        assert.equal(
          (
            await waitForJoinRoomAcknowledgement(client, {
              commandId: id,
              roomCode: created.snapshot.roomCode,
              displayName: name,
            })
          ).status,
          'ok',
        );
      }
      const full = await waitForJoinRoomAcknowledgement(extra!, {
        commandId: '60606060-6060-4060-8060-606060606060',
        roomCode: created.snapshot.roomCode,
        displayName: 'Finley',
      });
      assert.equal(full.status, 'error');
      if (full.status === 'error') assert.equal(full.code, 'ROOM_FULL');
      const fullReplay = await waitForJoinRoomAcknowledgement(extra!, {
        commandId: '60606060-6060-4060-8060-606060606060',
        roomCode: created.snapshot.roomCode,
        displayName: 'Finley',
      });
      assert.equal(fullReplay.status, 'error');
      if (fullReplay.status === 'error') {
        assert.equal(fullReplay.code, 'ROOM_FULL');
      }
      const isolatedJoin = await waitForJoinRoomAcknowledgement(extra!, {
        commandId: '70707070-7070-4070-8070-707070707070',
        roomCode: secondRoom.snapshot.roomCode,
        displayName: 'Finley',
      });
      assert.equal(isolatedJoin.status, 'ok');
    } finally {
      await close();
    }
  });

  it('survives an injected join runtime failure', async () => {
    const runtime: LobbyRuntime = {
      createRoom: () => ({
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Room creation failed',
      }),
      joinRoom: () => {
        throw new Error(READY_ERROR_MARKER);
      },
      prepareLobbySnapshotDeliveries: () => {
        throw new Error('Transport planning should not run');
      },
    };
    const { client, close } = await startSocketTest(
      createFakeDatabase(),
      runtime,
    );
    try {
      const response = await waitForJoinRoomAcknowledgement(client, {
        commandId: '80808080-8080-4080-8080-808080808080',
        roomCode: 'ABC234',
        displayName: 'Blair',
      });
      assert.deepEqual(response, {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Room join failed',
        commandId: '80808080-8080-4080-8080-808080808080',
      });
      assert.deepEqual(await waitForAcknowledgement(client), { status: 'ok' });
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
  server: GuandanServer;
  close: () => Promise<void>;
}> {
  let server: GuandanServer | undefined;
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
      createServer: (createdDatabase) => {
        server = createGuandanServer(createdDatabase, lobbyRuntime);
        return server;
      },
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

  assert.notEqual(server, undefined);
  return {
    client,
    server: server!,
    async close(): Promise<void> {
      client.disconnect();
      await runningServer.close();
    },
  };
}

async function startMultiClientTest(count: number): Promise<{
  runningServer: RunningServer;
  server: GuandanServer;
  clients: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>[];
  close: () => Promise<void>;
}> {
  const database = createFakeDatabase();
  let server: GuandanServer | undefined;
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
      createServer: (createdDatabase) => {
        server = createGuandanServer(createdDatabase);
        return server;
      },
    },
  );
  const clients = Array.from({ length: count }, () =>
    createSocketClient(`http://127.0.0.1:${runningServer.address.port}`, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    }),
  );
  await Promise.all(clients.map((client) => waitForConnection(client)));
  assert.notEqual(server, undefined);
  return {
    runningServer,
    server: server!,
    clients,
    async close(): Promise<void> {
      clients.forEach((client) => client.disconnect());
      await runningServer.close();
    },
  };
}

function waitForCreateRoomAcknowledgement(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
  payload: unknown,
  onAcknowledge?: (response: CreateRoomAcknowledgement) => void,
): Promise<CreateRoomAcknowledgement> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO create-room acknowledgement timed out'));
    }, 5_000);

    client.emit(LOBBY_CREATE_ROOM_EVENT, payload, (response) => {
      clearTimeout(timer);
      onAcknowledge?.(response);
      resolve(response);
    });
  });
}

function waitForJoinRoomAcknowledgement(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
  payload: unknown,
  onAcknowledge?: (response: JoinRoomAcknowledgement) => void,
): Promise<JoinRoomAcknowledgement> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO join-room acknowledgement timed out'));
    }, 5_000);

    client.emit(LOBBY_JOIN_ROOM_EVENT, payload, (response) => {
      clearTimeout(timer);
      onAcknowledge?.(response);
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

async function waitForCondition(
  condition: () => boolean,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Socket.IO condition timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
