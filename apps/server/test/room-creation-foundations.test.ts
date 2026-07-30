import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROOM_CODE_ALPHABET,
  parseCreateRoomSuccess,
  parseLobbySnapshotV1,
  parseRoomCode,
  type CreateRoomCommand,
  type RoomCode,
} from '@guandan/protocol';

import {
  LobbyConnectionAlreadyBoundError,
  createLobbyConnectionRegistry,
  type LobbyConnectionMembership,
} from '../src/lobby/connection-registry.js';
import {
  LobbyCommandReceiptConflictError,
  createLobbyCommandReceiptStore,
} from '../src/lobby/command-receipts.js';
import { createCreateRoomService } from '../src/lobby/create-room.js';
import {
  LobbyInvariantError,
  assertValidLobbyRoomState,
} from '../src/lobby/invariants.js';
import type { LobbyRoomState } from '../src/lobby/model.js';
import {
  LobbyRepositoryInsertError,
  createInMemoryLobbyRepository,
  type LobbyRepository,
} from '../src/lobby/repository.js';
import {
  MAX_ROOM_CODE_ATTEMPTS,
  createRoomCodeAllocator,
  createRoomCodeCandidate,
} from '../src/lobby/room-code.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_ROOM_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_PLAYER_ID = '66666666-6666-4666-8666-666666666666';
const COMMAND: CreateRoomCommand = {
  commandId: COMMAND_ID,
  displayName: 'Alex',
  settings: { startingLevel: 2, turnTimer: 'off' },
};

function createRoom(overrides: Partial<LobbyRoomState> = {}): LobbyRoomState {
  return {
    roomId: ROOM_ID,
    roomCode: 'ABC234',
    revision: 0,
    phase: 'lobby',
    hostPlayerId: PLAYER_ID,
    settings: { startingLevel: 2, turnTimer: 'off', hasPassword: false },
    players: [
      {
        playerId: PLAYER_ID,
        displayName: 'Alex',
        displayNameKey: 'alex',
        joinOrder: 0,
        seat: null,
        ready: false,
        connectionStatus: 'connected',
      },
    ],
    ...overrides,
  };
}

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error('Sequence exhausted');
    }
    index += 1;
    return value;
  };
}

function createHarness(
  options: {
    candidates?: readonly string[];
    identifiers?: readonly string[];
    repository?: LobbyRepository;
    receiptStore?: ReturnType<typeof createLobbyCommandReceiptStore>;
    projectSnapshot?: Parameters<
      typeof createCreateRoomService
    >[0]['projectSnapshot'];
    validateRoom?: Parameters<
      typeof createCreateRoomService
    >[0]['validateRoom'];
  } = {},
) {
  const repository = options.repository ?? createInMemoryLobbyRepository();
  const connectionRegistry = createLobbyConnectionRegistry();
  const receiptStore = options.receiptStore ?? createLobbyCommandReceiptStore();
  let candidateCalls = 0;
  let identifierCalls = 0;
  const candidateSequence = sequence(options.candidates ?? ['ABC234']);
  const identifierSequence = sequence(
    options.identifiers ?? [ROOM_ID, PLAYER_ID],
  );
  const roomCodeAllocator = createRoomCodeAllocator(repository, () => {
    candidateCalls += 1;
    return candidateSequence();
  });
  const service = createCreateRoomService({
    repository,
    roomCodeAllocator,
    connectionRegistry,
    receiptStore,
    generateIdentifier: () => {
      identifierCalls += 1;
      return identifierSequence();
    },
    ...(options.projectSnapshot === undefined
      ? {}
      : { projectSnapshot: options.projectSnapshot }),
    ...(options.validateRoom === undefined
      ? {}
      : { validateRoom: options.validateRoom }),
  });
  return {
    repository,
    connectionRegistry,
    receiptStore,
    service,
    calls: () => ({ candidateCalls, identifierCalls }),
  };
}

describe('in-memory lobby repository', () => {
  it('inserts and retrieves by ID and code', () => {
    const repository = createInMemoryLobbyRepository();
    const stored = repository.insert(createRoom());
    assert.equal(repository.getById(ROOM_ID), stored);
    assert.equal(repository.getByCode('ABC234'), stored);
    assert.equal(repository.hasRoomCode('ABC234'), true);
    assert.equal(repository.count(), 1);
  });

  it('holds multiple isolated rooms', () => {
    const repository = createInMemoryLobbyRepository();
    repository.insert(createRoom());
    repository.insert(
      createRoom({
        roomId: SECOND_ROOM_ID,
        roomCode: 'DEF567',
        hostPlayerId: SECOND_PLAYER_ID,
        players: [
          {
            ...createRoom().players[0]!,
            playerId: SECOND_PLAYER_ID,
            displayName: 'Blair',
            displayNameKey: 'blair',
          },
        ],
      }),
    );
    assert.equal(repository.count(), 2);
    assert.notEqual(
      repository.getById(ROOM_ID),
      repository.getById(SECOND_ROOM_ID),
    );
  });

  it('rejects duplicate IDs and preserves indexes', () => {
    const repository = createInMemoryLobbyRepository();
    const original = repository.insert(createRoom());
    assert.throws(
      () => repository.insert(createRoom({ roomCode: 'DEF567' })),
      (error) =>
        error instanceof LobbyRepositoryInsertError &&
        error.failure === 'duplicate-room-id',
    );
    assert.equal(repository.count(), 1);
    assert.equal(repository.getById(ROOM_ID), original);
    assert.equal(repository.getByCode('DEF567'), undefined);
  });

  it('rejects duplicate codes and preserves indexes', () => {
    const repository = createInMemoryLobbyRepository();
    const original = repository.insert(createRoom());
    assert.throws(
      () => repository.insert(createRoom({ roomId: SECOND_ROOM_ID })),
      (error) =>
        error instanceof LobbyRepositoryInsertError &&
        error.failure === 'duplicate-room-code',
    );
    assert.equal(repository.count(), 1);
    assert.equal(repository.getByCode('ABC234'), original);
    assert.equal(repository.getById(SECOND_ROOM_ID), undefined);
  });

  it('deletes both indexes for rollback', () => {
    const repository = createInMemoryLobbyRepository();
    repository.insert(createRoom());
    assert.equal(repository.deleteForRollback(ROOM_ID), true);
    assert.equal(repository.getById(ROOM_ID), undefined);
    assert.equal(repository.getByCode('ABC234'), undefined);
    assert.equal(repository.count(), 0);
  });

  it('rejects invalid state before insertion', () => {
    const repository = createInMemoryLobbyRepository();
    assert.throws(() => repository.insert(createRoom({ revision: -1 })));
    assert.equal(repository.count(), 0);
  });

  it('owns a deeply frozen clone immune to caller mutation', () => {
    const repository = createInMemoryLobbyRepository();
    const callerRoom = createRoom();
    const stored = repository.insert(callerRoom);
    callerRoom.roomCode = 'DEF567';
    callerRoom.settings.startingLevel = 7;
    callerRoom.players[0]!.displayName = 'Changed';
    assert.equal(stored.roomCode, 'ABC234');
    assert.equal(stored.settings.startingLevel, 2);
    assert.equal(stored.players[0]?.displayName, 'Alex');
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.settings), true);
    assert.equal(Object.isFrozen(stored.players), true);
    assert.equal(Object.isFrozen(stored.players[0]), true);
    assert.equal(repository.getByCode('ABC234'), stored);
    assert.equal(repository.getByCode('DEF567'), undefined);
  });
});

describe('room-code generation and allocation', () => {
  it('generates valid output using only the approved alphabet', () => {
    for (let index = 0; index < 32; index += 1) {
      const code = createRoomCodeCandidate();
      assert.equal(parseRoomCode(code), code);
      assert.equal(code.length, 6);
      assert.equal(
        [...code].every((character) => ROOM_CODE_ALPHABET.includes(character)),
        true,
      );
    }
  });

  it('accepts the first available injected candidate', () => {
    const repository = createInMemoryLobbyRepository();
    let accepted: RoomCode | undefined;
    const result = createRoomCodeAllocator(repository, () => 'ABC234').allocate(
      (code) => {
        accepted = code;
        return code;
      },
    );
    assert.equal(result, 'ABC234');
    assert.equal(accepted, 'ABC234');
  });

  it('skips indexed collisions before success', () => {
    const repository = createInMemoryLobbyRepository();
    repository.insert(createRoom());
    const next = sequence(['ABC234', 'ABC234', 'DEF567']);
    assert.equal(
      createRoomCodeAllocator(repository, next).allocate((code) => code),
      'DEF567',
    );
  });

  it('treats insertion-time duplicate codes as collisions', () => {
    const base = createInMemoryLobbyRepository();
    let insertionCalls = 0;
    const allocator = createRoomCodeAllocator(
      { hasRoomCode: () => false },
      () => (insertionCalls === 0 ? 'ABC234' : 'DEF567'),
    );
    const result = allocator.allocate((code) => {
      insertionCalls += 1;
      if (insertionCalls === 1) {
        throw new LobbyRepositoryInsertError('duplicate-room-code');
      }
      return base.insert(createRoom({ roomCode: code }));
    });
    assert.equal(result?.roomCode, 'DEF567');
    assert.equal(insertionCalls, 2);
  });

  it('stops after exactly 32 collisions and changes nothing', () => {
    const repository = createInMemoryLobbyRepository();
    repository.insert(createRoom());
    let calls = 0;
    const allocator = createRoomCodeAllocator(repository, () => {
      calls += 1;
      return 'ABC234';
    });
    assert.equal(
      allocator.allocate((code) => code),
      undefined,
    );
    assert.equal(calls, MAX_ROOM_CODE_ATTEMPTS);
    assert.equal(repository.count(), 1);
  });
});

describe('connection and receipt registries', () => {
  it('binds, retrieves, rejects duplicate bind, and rolls back', () => {
    const registry = createLobbyConnectionRegistry();
    const binding = { roomId: ROOM_ID, playerId: PLAYER_ID };
    registry.bind('socket-a', binding);
    assert.deepEqual(registry.get('socket-a'), binding);
    assert.throws(
      () => registry.bind('socket-a', binding),
      LobbyConnectionAlreadyBoundError,
    );
    assert.equal(registry.unbindForRollback('socket-a', binding), true);
    assert.equal(registry.get('socket-a'), undefined);
    assert.equal(registry.unbindForRollback('socket-a', binding), true);
  });

  it('lists immutable room-isolated memberships in binding order', () => {
    const registry = createLobbyConnectionRegistry();
    registry.bind('socket-a', { roomId: ROOM_ID, playerId: PLAYER_ID });
    registry.bind('socket-b', {
      roomId: SECOND_ROOM_ID,
      playerId: SECOND_PLAYER_ID,
    });
    registry.bind('socket-c', { roomId: ROOM_ID, playerId: SECOND_PLAYER_ID });

    const memberships = registry.listByRoomId(ROOM_ID);
    assert.deepEqual(memberships, [
      { socketId: 'socket-a', roomId: ROOM_ID, playerId: PLAYER_ID },
      { socketId: 'socket-c', roomId: ROOM_ID, playerId: SECOND_PLAYER_ID },
    ]);
    assert.equal(Object.isFrozen(memberships), true);
    assert.equal(Object.isFrozen(memberships[0]), true);
    assert.throws(() => {
      (memberships as LobbyConnectionMembership[]).push({
        socketId: 'socket-d',
        roomId: ROOM_ID,
        playerId: PLAYER_ID,
      });
    }, TypeError);
    assert.equal(registry.listByRoomId(SECOND_ROOM_ID).length, 1);
  });

  it('rejects malformed room IDs when listing memberships', () => {
    const registry = createLobbyConnectionRegistry();
    assert.throws(() => registry.listByRoomId('invalid'));
  });

  it('rejects replacing an existing command receipt', () => {
    const store = createLobbyCommandReceiptStore();
    const success = createHarness().service.create('socket-a', COMMAND);
    assert.equal(success.status, 'ok');
    if (success.status !== 'ok') {
      return;
    }
    store.insert({
      commandKind: 'create-room',
      socketId: 'socket-a',
      command: COMMAND,
      success,
    });
    assert.throws(
      () =>
        store.insert({
          commandKind: 'create-room',
          socketId: 'socket-a',
          command: COMMAND,
          success,
        }),
      LobbyCommandReceiptConflictError,
    );
  });
});

describe('authoritative create-room service', () => {
  it('creates the complete initial room and creator snapshot', () => {
    const harness = createHarness();
    const response = harness.service.create('socket-a', COMMAND);
    assert.equal(response.status, 'ok');
    if (response.status !== 'ok') {
      return;
    }

    assert.deepEqual(parseCreateRoomSuccess(response), response);
    assert.deepEqual(
      parseLobbySnapshotV1(response.snapshot),
      response.snapshot,
    );
    assert.equal(response.commandId, COMMAND_ID);
    assert.equal(response.roomRevision, 0);
    assert.equal(response.snapshot.roomId, ROOM_ID);
    assert.equal(response.snapshot.roomCode, 'ABC234');
    assert.equal(response.snapshot.selfPlayerId, PLAYER_ID);
    assert.equal(response.snapshot.hostPlayerId, PLAYER_ID);
    assert.equal(response.snapshot.settings.hasPassword, false);
    assert.deepEqual(response.snapshot.capabilities, {
      canChangeSettings: true,
      canManageSeats: true,
      canRemovePlayers: true,
      canStartMatch: false,
    });
    assert.deepEqual(response.snapshot.players, [
      {
        playerId: PLAYER_ID,
        displayName: 'Alex',
        seat: null,
        ready: false,
        connectionStatus: 'connected',
        isHost: true,
        isSelf: true,
      },
    ]);

    const room = harness.repository.getById(ROOM_ID);
    assert.notEqual(room, undefined);
    assertValidLobbyRoomState(room);
    assert.equal(room.hostPlayerId, PLAYER_ID);
    assert.equal(room.revision, 0);
    assert.equal(room.players.length, 1);
    assert.equal(room.players[0]?.displayNameKey, 'alex');
    assert.equal(room.players[0]?.joinOrder, 0);
    assert.equal(harness.repository.getByCode('ABC234'), room);
    assert.equal(harness.repository.count(), 1);
    assert.deepEqual(harness.connectionRegistry.get('socket-a'), {
      roomId: ROOM_ID,
      playerId: PLAYER_ID,
    });
  });

  it('normalizes the name and stores the derived key', () => {
    const harness = createHarness();
    const response = harness.service.create('socket-a', {
      ...COMMAND,
      displayName: '  Ａｌｅｘ  Smith  ',
    });
    assert.equal(response.status, 'ok');
    const room = harness.repository.getById(ROOM_ID);
    assert.equal(room?.players[0]?.displayName, 'Alex Smith');
    assert.equal(room?.players[0]?.displayNameKey, 'alex smith');
  });

  it('replays an identical retry without calling generators again', () => {
    const harness = createHarness();
    const first = harness.service.create('socket-a', COMMAND);
    const callsAfterFirst = harness.calls();
    const second = harness.service.create('socket-a', { ...COMMAND });
    assert.deepEqual(second, first);
    assert.equal(second, first);
    assert.deepEqual(harness.calls(), callsAfterFirst);
    assert.equal(harness.repository.count(), 1);
  });

  it('rejects same-command payload conflicts', () => {
    const harness = createHarness();
    harness.service.create('socket-a', COMMAND);
    const response = harness.service.create('socket-a', {
      ...COMMAND,
      displayName: 'Blair',
    });
    assert.deepEqual(response, {
      status: 'error',
      code: 'COMMAND_ID_CONFLICT',
      message: 'Command ID conflicts with an existing command',
      commandId: COMMAND_ID,
    });
    assert.equal(harness.repository.count(), 1);
  });

  it('rejects cross-socket command reuse without exposing success', () => {
    const harness = createHarness();
    harness.service.create('socket-a', COMMAND);
    const response = harness.service.create('socket-b', COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'COMMAND_ID_CONFLICT');
    }
    assert.equal(harness.repository.count(), 1);
  });

  it('rejects a new command from an already-bound socket', () => {
    const harness = createHarness();
    harness.service.create('socket-a', COMMAND);
    const response = harness.service.create('socket-a', {
      ...COMMAND,
      commandId: SECOND_COMMAND_ID,
    });
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'ALREADY_IN_ROOM');
    }
    assert.equal(harness.repository.count(), 1);
  });

  it('returns ROOM_CODE_UNAVAILABLE after 32 collisions without a receipt', () => {
    const repository = createInMemoryLobbyRepository();
    repository.insert(createRoom());
    const harness = createHarness({
      repository,
      candidates: Array.from({ length: 64 }, () => 'ABC234'),
      identifiers: [ROOM_ID, PLAYER_ID, SECOND_ROOM_ID, SECOND_PLAYER_ID],
    });
    const first = harness.service.create('socket-a', COMMAND);
    assert.equal(first.status, 'error');
    if (first.status === 'error') {
      assert.equal(first.code, 'ROOM_CODE_UNAVAILABLE');
    }
    assert.deepEqual(harness.calls(), {
      candidateCalls: 32,
      identifierCalls: 2,
    });
    assert.equal(repository.count(), 1);
    assert.equal(harness.connectionRegistry.get('socket-a'), undefined);
    const retry = harness.service.create('socket-a', COMMAND);
    assert.equal(retry.status, 'error');
    assert.deepEqual(harness.calls(), {
      candidateCalls: 64,
      identifierCalls: 4,
    });
  });

  it('maps invalid constructed state to INVALID_LOBBY_STATE', () => {
    const harness = createHarness({
      validateRoom: () => {
        throw new LobbyInvariantError('internal invariant detail');
      },
    });
    const response = harness.service.create('socket-a', COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'INVALID_LOBBY_STATE');
      assert.equal(response.message.includes('invariant'), false);
    }
  });

  it('rolls back room insertion when binding fails', () => {
    const repository = createInMemoryLobbyRepository();
    const connectionRegistry = createLobbyConnectionRegistry();
    connectionRegistry.bind('socket-a', {
      roomId: SECOND_ROOM_ID,
      playerId: SECOND_PLAYER_ID,
    });
    const receiptStore = createLobbyCommandReceiptStore();
    const service = createCreateRoomService({
      repository,
      roomCodeAllocator: createRoomCodeAllocator(repository, () => 'ABC234'),
      connectionRegistry: {
        get: () => undefined,
        listByRoomId: connectionRegistry.listByRoomId,
        bind: connectionRegistry.bind,
        unbindForRollback: connectionRegistry.unbindForRollback,
      },
      receiptStore,
      generateIdentifier: sequence([ROOM_ID, PLAYER_ID]),
    });
    const response = service.create('socket-a', COMMAND);
    assert.equal(response.status, 'error');
    assert.equal(repository.count(), 0);
    assert.deepEqual(connectionRegistry.get('socket-a'), {
      roomId: SECOND_ROOM_ID,
      playerId: SECOND_PLAYER_ID,
    });
  });

  it('rolls back room and binding when projection fails', () => {
    const harness = createHarness({
      projectSnapshot: () => {
        throw new Error('projection detail');
      },
    });
    const response = harness.service.create('socket-a', COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'INTERNAL_ERROR');
      assert.equal(response.message.includes('projection'), false);
    }
    assert.equal(harness.repository.count(), 0);
    assert.equal(harness.connectionRegistry.get('socket-a'), undefined);
    assert.equal(harness.receiptStore.get(COMMAND_ID), undefined);
  });

  it('rolls back room and binding when receipt insertion fails', () => {
    const baseStore = createLobbyCommandReceiptStore();
    const receiptStore = {
      get: baseStore.get,
      insert: () => {
        throw new Error('receipt detail');
      },
    };
    const harness = createHarness({ receiptStore });
    const response = harness.service.create('socket-a', COMMAND);
    assert.equal(response.status, 'error');
    assert.equal(harness.repository.count(), 0);
    assert.equal(harness.connectionRegistry.get('socket-a'), undefined);
  });

  it('sanitizes generator defects and unexpected repository failures', () => {
    const invalidGenerator = createHarness({ identifiers: ['invalid'] });
    const invalidResponse = invalidGenerator.service.create(
      'socket-a',
      COMMAND,
    );
    assert.deepEqual(invalidResponse, {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Room creation failed',
      commandId: COMMAND_ID,
    });

    const repository = createInMemoryLobbyRepository();
    const failingRepository: LobbyRepository = {
      ...repository,
      insert: () => {
        throw new Error('repository detail');
      },
    };
    const repositoryResponse = createHarness({
      repository: failingRepository,
    }).service.create('socket-a', COMMAND);
    assert.equal(repositoryResponse.status, 'error');
    if (repositoryResponse.status === 'error') {
      assert.equal(repositoryResponse.code, 'INTERNAL_ERROR');
      assert.equal(repositoryResponse.message.includes('repository'), false);
    }
  });

  it('serializes same-code and same-command submissions synchronously', () => {
    const repository = createInMemoryLobbyRepository();
    const candidates = sequence(['ABC234', 'ABC234', 'DEF567']);
    const allocator = createRoomCodeAllocator(repository, candidates);
    const firstHarness = createHarness({
      repository,
      candidates: ['ABC234'],
      identifiers: [ROOM_ID, PLAYER_ID],
    });
    const secondService = createCreateRoomService({
      repository,
      roomCodeAllocator: allocator,
      connectionRegistry: createLobbyConnectionRegistry(),
      receiptStore: firstHarness.receiptStore,
      generateIdentifier: sequence([SECOND_ROOM_ID, SECOND_PLAYER_ID]),
    });
    const first = firstHarness.service.create('socket-a', COMMAND);
    const sameCommand = secondService.create('socket-b', COMMAND);
    const second = secondService.create('socket-b', {
      ...COMMAND,
      commandId: SECOND_COMMAND_ID,
      displayName: 'Blair',
    });
    assert.equal(first.status, 'ok');
    assert.equal(sameCommand.status, 'error');
    if (sameCommand.status === 'error') {
      assert.equal(sameCommand.code, 'COMMAND_ID_CONFLICT');
    }
    assert.equal(second.status, 'ok');
    if (first.status === 'ok' && second.status === 'ok') {
      assert.equal(first.snapshot.roomCode, 'ABC234');
      assert.equal(second.snapshot.roomCode, 'DEF567');
    }
    assert.equal(repository.count(), 2);
  });
});
