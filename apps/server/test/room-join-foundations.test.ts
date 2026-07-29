import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseJoinRoomSuccess,
  type CreateRoomCommand,
  type JoinRoomCommand,
  type PlayerId,
} from '@guandan/protocol';

import {
  LobbyCommandReceiptConflictError,
  createLobbyCommandReceiptStore,
} from '../src/lobby/command-receipts.js';
import { createLobbyConnectionRegistry } from '../src/lobby/connection-registry.js';
import { createCreateRoomService } from '../src/lobby/create-room.js';
import { LobbyInvariantError } from '../src/lobby/invariants.js';
import { createJoinRoomService } from '../src/lobby/join-room.js';
import type { LobbyPlayerState, LobbyRoomState } from '../src/lobby/model.js';
import {
  LobbyRepositoryReplaceError,
  createInMemoryLobbyRepository,
  type LobbyRepository,
} from '../src/lobby/repository.js';
import { createRoomCodeAllocator } from '../src/lobby/room-code.js';

const CREATE_ID = '11111111-1111-4111-8111-111111111111';
const JOIN_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_JOIN_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '44444444-4444-4444-8444-444444444444';
const HOST_ID = '55555555-5555-4555-8555-555555555555';
const JOINER_ID = '66666666-6666-4666-8666-666666666666';
const THIRD_ID = '77777777-7777-4777-8777-777777777777';
const FOURTH_ID = '88888888-8888-4888-8888-888888888888';
const CREATE_COMMAND: CreateRoomCommand = {
  commandId: CREATE_ID,
  displayName: 'Alex',
  settings: { startingLevel: 2, turnTimer: 'off' },
};
const JOIN_COMMAND: JoinRoomCommand = {
  commandId: JOIN_ID,
  roomCode: 'ABC234',
  displayName: 'Blair',
};

function player(
  playerId: PlayerId,
  displayName: string,
  joinOrder: number,
  overrides: Partial<LobbyPlayerState> = {},
): LobbyPlayerState {
  return {
    playerId,
    displayName,
    displayNameKey: displayName.toLocaleLowerCase('en-US'),
    joinOrder,
    seat: null,
    ready: false,
    connectionStatus: 'connected',
    ...overrides,
  };
}

function room(overrides: Partial<LobbyRoomState> = {}): LobbyRoomState {
  return {
    roomId: ROOM_ID,
    roomCode: 'ABC234',
    revision: 0,
    phase: 'lobby',
    hostPlayerId: HOST_ID,
    settings: { startingLevel: 2, turnTimer: 'off', hasPassword: false },
    players: [player(HOST_ID, 'Alex', 0)],
    ...overrides,
  };
}

function sequence(values: readonly string[]): () => string {
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

function harness(
  options: {
    initialRoom?: LobbyRoomState;
    identifiers?: readonly string[];
    repository?: LobbyRepository;
    projectSnapshot?: Parameters<
      typeof createJoinRoomService
    >[0]['projectSnapshot'];
    parseSuccess?: Parameters<typeof createJoinRoomService>[0]['parseSuccess'];
    validateRoom?: Parameters<typeof createJoinRoomService>[0]['validateRoom'];
    receiptStore?: ReturnType<typeof createLobbyCommandReceiptStore>;
  } = {},
) {
  const repository = options.repository ?? createInMemoryLobbyRepository();
  if (options.initialRoom !== undefined) {
    repository.insert(options.initialRoom);
  }
  const connectionRegistry = createLobbyConnectionRegistry();
  const receiptStore = options.receiptStore ?? createLobbyCommandReceiptStore();
  let identifierCalls = 0;
  const identifiers = sequence(options.identifiers ?? [JOINER_ID]);
  const service = createJoinRoomService({
    repository,
    connectionRegistry,
    receiptStore,
    generateIdentifier: () => {
      identifierCalls += 1;
      return identifiers();
    },
    ...(options.projectSnapshot === undefined
      ? {}
      : { projectSnapshot: options.projectSnapshot }),
    ...(options.parseSuccess === undefined
      ? {}
      : { parseSuccess: options.parseSuccess }),
    ...(options.validateRoom === undefined
      ? {}
      : { validateRoom: options.validateRoom }),
  });
  return {
    repository,
    connectionRegistry,
    receiptStore,
    service,
    identifierCalls: () => identifierCalls,
  };
}

function nextRoom(current: LobbyRoomState): LobbyRoomState {
  return {
    ...current,
    revision: current.revision + 1,
    players: [...current.players, player(JOINER_ID, 'Blair', 1)],
  };
}

describe('immutable repository replacement', () => {
  it('returns exact previous and immutable next room while preserving indexes', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    const callerNext = nextRoom(previous);
    const result = repository.replaceRoom({
      roomId: ROOM_ID,
      expectedRevision: 0,
      nextRoom: callerNext,
    });
    assert.equal(result.previousRoom, previous);
    assert.equal(result.storedRoom.revision, 1);
    assert.equal(repository.getById(ROOM_ID), result.storedRoom);
    assert.equal(repository.getByCode('ABC234'), result.storedRoom);
    assert.equal(repository.count(), 1);
    callerNext.players[1]!.displayName = 'Changed';
    assert.equal(result.storedRoom.players[1]?.displayName, 'Blair');
    assert.equal(Object.isFrozen(result.storedRoom), true);
    assert.deepEqual(result.storedRoom.settings, previous.settings);
    assert.deepEqual(result.storedRoom.players[0], previous.players[0]);
  });

  for (const [name, createInput] of [
    [
      'missing room',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: nextRoom(room()),
      }),
    ],
    [
      'stale revision',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 1,
        nextRoom: { ...nextRoom(room()), revision: 2 },
      }),
    ],
    [
      'same revision',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: { ...nextRoom(room()), revision: 0 },
      }),
    ],
    [
      'revision jump',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: { ...nextRoom(room()), revision: 2 },
      }),
    ],
    [
      'room ID change',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: {
          ...nextRoom(room()),
          roomId: '99999999-9999-4999-8999-999999999999',
        },
      }),
    ],
    [
      'room code change',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: { ...nextRoom(room()), roomCode: 'DEF567' },
      }),
    ],
    [
      'existing player change',
      () => {
        const next = nextRoom(room());
        next.players[0] = { ...next.players[0]!, displayName: 'Changed' };
        return { roomId: ROOM_ID, expectedRevision: 0, nextRoom: next };
      },
    ],
    [
      'invalid next room',
      () => ({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: { ...nextRoom(room()), hostPlayerId: JOINER_ID },
      }),
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      const repository = createInMemoryLobbyRepository();
      if (name !== 'missing room') {
        repository.insert(room());
      }
      assert.throws(() => repository.replaceRoom(createInput()));
      assert.equal(repository.count(), name === 'missing room' ? 0 : 1);
    });
  }

  it('rejects revision overflow', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(
      room({ revision: Number.MAX_SAFE_INTEGER }),
    );
    assert.throws(
      () =>
        repository.replaceRoom({
          roomId: ROOM_ID,
          expectedRevision: Number.MAX_SAFE_INTEGER,
          nextRoom: { ...previous, players: [...previous.players] },
        }),
      (error) =>
        error instanceof LobbyRepositoryReplaceError &&
        error.failure === 'revision-overflow',
    );
  });

  it('conditionally restores the exact previous stored room', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    const replacement = repository.replaceRoom({
      roomId: ROOM_ID,
      expectedRevision: 0,
      nextRoom: nextRoom(previous),
    });
    const restored = repository.restoreRoomForRollback({
      roomId: ROOM_ID,
      expectedCurrentRevision: 1,
      previousRoom: replacement.previousRoom,
    });
    assert.notEqual(restored, previous);
    assert.deepEqual(restored, previous);
    assert.equal(repository.getById(ROOM_ID), restored);
    assert.equal(repository.getByCode('ABC234'), restored);
    assert.equal(repository.count(), 1);
    assert.equal(Object.isFrozen(restored), true);
    assert.equal(Object.isFrozen(restored.settings), true);
    assert.equal(Object.isFrozen(restored.players), true);
    assert.equal(Object.isFrozen(restored.players[0]), true);
  });

  it('owns a frozen clone of the rollback input', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    repository.replaceRoom({
      roomId: ROOM_ID,
      expectedRevision: 0,
      nextRoom: nextRoom(previous),
    });
    const rollbackInput: LobbyRoomState = {
      ...previous,
      settings: { ...previous.settings },
      players: previous.players.map((entry) => ({ ...entry })),
    };
    const restored = repository.restoreRoomForRollback({
      roomId: ROOM_ID,
      expectedCurrentRevision: 1,
      previousRoom: rollbackInput,
    });

    rollbackInput.settings.startingLevel = 7;
    rollbackInput.players[0]!.displayName = 'Changed';
    assert.equal(restored.settings.startingLevel, 2);
    assert.equal(restored.players[0]?.displayName, 'Alex');
    assert.equal(repository.getByCode('ABC234'), restored);
  });

  it('refuses rollback over a newer room state', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    const first = repository.replaceRoom({
      roomId: ROOM_ID,
      expectedRevision: 0,
      nextRoom: nextRoom(previous),
    });
    repository.replaceRoom({
      roomId: ROOM_ID,
      expectedRevision: 1,
      nextRoom: {
        ...first.storedRoom,
        revision: 2,
        players: [...first.storedRoom.players, player(THIRD_ID, 'Casey', 2)],
      },
    });
    assert.throws(() =>
      repository.restoreRoomForRollback({
        roomId: ROOM_ID,
        expectedCurrentRevision: 1,
        previousRoom: previous,
      }),
    );
    assert.equal(repository.getById(ROOM_ID)?.revision, 2);
  });

  it('rejects rollback with a different identity, code, or prior revision', () => {
    for (const previousRoom of [
      {
        ...room(),
        roomId: '99999999-9999-4999-8999-999999999999',
      },
      { ...room(), roomCode: 'DEF567' },
      { ...room(), revision: 1 },
    ] as LobbyRoomState[]) {
      const repository = createInMemoryLobbyRepository();
      const previous = repository.insert(room());
      const replacement = repository.replaceRoom({
        roomId: ROOM_ID,
        expectedRevision: 0,
        nextRoom: nextRoom(previous),
      });
      assert.throws(() =>
        repository.restoreRoomForRollback({
          roomId: ROOM_ID,
          expectedCurrentRevision: 1,
          previousRoom,
        }),
      );
      assert.equal(repository.getById(ROOM_ID), replacement.storedRoom);
      assert.equal(repository.getByCode('ABC234'), replacement.storedRoom);
    }
  });
});

describe('global lobby command receipts', () => {
  it('preserves exact create replay and rejects cross-kind reuse', () => {
    const repository = createInMemoryLobbyRepository();
    const registry = createLobbyConnectionRegistry();
    const receipts = createLobbyCommandReceiptStore();
    let createIdentifierCalls = 0;
    const createService = createCreateRoomService({
      repository,
      roomCodeAllocator: createRoomCodeAllocator(repository, () => 'ABC234'),
      connectionRegistry: registry,
      receiptStore: receipts,
      generateIdentifier: () => {
        createIdentifierCalls += 1;
        return createIdentifierCalls === 1 ? ROOM_ID : HOST_ID;
      },
    });
    const first = createService.create('creator', CREATE_COMMAND);
    const replay = createService.create('creator', CREATE_COMMAND);
    assert.equal(replay, first);
    assert.equal(createIdentifierCalls, 2);

    const join = createJoinRoomService({
      repository,
      connectionRegistry: registry,
      receiptStore: receipts,
      generateIdentifier: () => JOINER_ID,
    }).join('joiner', {
      ...JOIN_COMMAND,
      commandId: CREATE_ID,
    });
    assert.equal(join.status, 'error');
    if (join.status === 'error') {
      assert.equal(join.code, 'COMMAND_ID_CONFLICT');
    }
  });

  it('rejects receipt replacement', () => {
    const setup = harness({ initialRoom: room() });
    const success = setup.service.join('joiner', JOIN_COMMAND);
    assert.equal(success.status, 'ok');
    if (success.status !== 'ok') return;
    assert.throws(
      () =>
        setup.receiptStore.insert({
          commandKind: 'join-room',
          socketId: 'joiner',
          command: JOIN_COMMAND,
          success,
        }),
      LobbyCommandReceiptConflictError,
    );
  });

  it('rejects join command IDs reused by create-room', () => {
    const repository = createInMemoryLobbyRepository();
    repository.insert(room());
    const registry = createLobbyConnectionRegistry();
    const receipts = createLobbyCommandReceiptStore();
    const joined = createJoinRoomService({
      repository,
      connectionRegistry: registry,
      receiptStore: receipts,
      generateIdentifier: () => JOINER_ID,
    }).join('joiner', JOIN_COMMAND);
    assert.equal(joined.status, 'ok');

    const createIdentifier = sequence([
      '99999999-9999-4999-8999-999999999999',
      FOURTH_ID,
    ]);
    let identifierCalls = 0;
    const created = createCreateRoomService({
      repository,
      roomCodeAllocator: createRoomCodeAllocator(repository, () => 'DEF567'),
      connectionRegistry: registry,
      receiptStore: receipts,
      generateIdentifier: () => {
        identifierCalls += 1;
        return createIdentifier();
      },
    }).create('creator', { ...CREATE_COMMAND, commandId: JOIN_ID });

    assert.equal(created.status, 'error');
    if (created.status === 'error') {
      assert.equal(created.code, 'COMMAND_ID_CONFLICT');
    }
    assert.equal(identifierCalls, 0);
    assert.equal(repository.count(), 1);
    assert.equal(repository.getByCode('ABC234')?.players.length, 2);
    assert.equal(repository.getByCode('DEF567'), undefined);
  });
});

describe('authoritative join-room service', () => {
  it('joins a second player with generated and derived state', () => {
    const setup = harness({ initialRoom: room() });
    const response = setup.service.join('joiner', JOIN_COMMAND);
    assert.equal(response.status, 'ok');
    if (response.status !== 'ok') return;
    assert.deepEqual(parseJoinRoomSuccess(response), response);
    assert.equal(response.roomRevision, 1);
    assert.equal(response.snapshot.selfPlayerId, JOINER_ID);
    assert.equal(response.snapshot.hostPlayerId, HOST_ID);
    assert.deepEqual(response.snapshot.capabilities, {
      canChangeSettings: false,
      canManageSeats: false,
      canRemovePlayers: false,
      canStartMatch: false,
    });
    const stored = setup.repository.getByCode('ABC234');
    assert.equal(stored?.revision, 1);
    assert.deepEqual(stored?.players[0], room().players[0]);
    assert.deepEqual(stored?.settings, room().settings);
    assert.deepEqual(stored?.players[1], {
      playerId: JOINER_ID,
      displayName: 'Blair',
      displayNameKey: 'blair',
      joinOrder: 1,
      seat: null,
      ready: false,
      connectionStatus: 'connected',
    });
    assert.deepEqual(setup.connectionRegistry.get('joiner'), {
      roomId: ROOM_ID,
      playerId: JOINER_ID,
    });
  });

  it('joins third and fourth players with max join order plus one', () => {
    const initial = room({
      revision: 4,
      players: [player(HOST_ID, 'Alex', 0), player(THIRD_ID, 'Casey', 5)],
    });
    const setup = harness({
      initialRoom: initial,
      identifiers: [JOINER_ID, FOURTH_ID],
    });
    const second = setup.service.join('second', JOIN_COMMAND);
    const third = setup.service.join('third', {
      ...JOIN_COMMAND,
      commandId: SECOND_JOIN_ID,
      displayName: 'Devon',
    });
    assert.equal(second.status, 'ok');
    assert.equal(third.status, 'ok');
    assert.deepEqual(
      setup.repository
        .getByCode('ABC234')
        ?.players.map((entry) => [entry.displayName, entry.joinOrder]),
      [
        ['Alex', 0],
        ['Casey', 5],
        ['Blair', 6],
        ['Devon', 7],
      ],
    );
    assert.equal(setup.repository.getByCode('ABC234')?.revision, 6);
  });

  it('enforces membership, lookup, protection, capacity, and name precedence', () => {
    const missing = harness();
    assert.equal(
      (missing.service.join('socket', JOIN_COMMAND) as { code: string }).code,
      'ROOM_NOT_FOUND',
    );

    const protectedSetup = harness({
      initialRoom: room({
        settings: { startingLevel: 2, turnTimer: 'off', hasPassword: true },
        players: [
          player(HOST_ID, 'Alex', 0),
          player(THIRD_ID, 'Blair', 1),
          player(FOURTH_ID, 'Casey', 2),
          player(JOINER_ID, 'Devon', 3),
        ],
      }),
    });
    const protectedResult = protectedSetup.service.join('socket', JOIN_COMMAND);
    assert.equal(protectedResult.status, 'error');
    if (protectedResult.status === 'error') {
      assert.equal(protectedResult.code, 'INTERNAL_ERROR');
    }

    const full = harness({
      initialRoom: room({
        players: [
          player(HOST_ID, 'Alex', 0),
          player(THIRD_ID, 'Casey', 1),
          player(FOURTH_ID, 'Devon', 2),
          player(JOINER_ID, 'Emery', 3),
        ],
      }),
    });
    assert.equal(
      (full.service.join('socket', JOIN_COMMAND) as { code: string }).code,
      'ROOM_FULL',
    );

    for (const displayName of ['Alex', 'alex', 'Ａｌｅｘ', ' Alex ']) {
      const names = harness({ initialRoom: room() });
      const result = names.service.join('socket', {
        ...JOIN_COMMAND,
        displayName,
      });
      assert.equal(result.status, 'error');
      if (result.status === 'error') assert.equal(result.code, 'NAME_TAKEN');
    }

    const bound = harness({ initialRoom: room() });
    bound.connectionRegistry.bind('socket', {
      roomId: ROOM_ID,
      playerId: HOST_ID,
    });
    const boundResult = bound.service.join('socket', JOIN_COMMAND);
    assert.equal(boundResult.status, 'error');
    if (boundResult.status === 'error') {
      assert.equal(boundResult.code, 'ALREADY_IN_ROOM');
    }
  });

  it('replays exactly without generation or revision change', () => {
    const setup = harness({ initialRoom: room() });
    const first = setup.service.join('joiner', JOIN_COMMAND);
    const second = setup.service.join('joiner', { ...JOIN_COMMAND });
    assert.equal(second, first);
    assert.equal(setup.identifierCalls(), 1);
    assert.equal(setup.repository.getByCode('ABC234')?.revision, 1);
    assert.equal(setup.repository.getByCode('ABC234')?.players.length, 2);
  });

  it('rejects payload, cross-socket, and cross-kind conflicts before membership', () => {
    const setup = harness({ initialRoom: room() });
    setup.service.join('joiner', JOIN_COMMAND);
    setup.connectionRegistry.bind('other', {
      roomId: ROOM_ID,
      playerId: THIRD_ID,
    });
    for (const [socketId, value] of [
      ['joiner', { ...JOIN_COMMAND, roomCode: 'DEF567' }],
      ['joiner', { ...JOIN_COMMAND, displayName: 'Changed' }],
      ['other', JOIN_COMMAND],
    ] as const) {
      const response = setup.service.join(socketId, value);
      assert.equal(response.status, 'error');
      if (response.status === 'error') {
        assert.equal(response.code, 'COMMAND_ID_CONFLICT');
      }
    }
  });

  for (const [name, initialRoom, identifiers] of [
    ['invalid generated ID', room(), ['invalid']],
    ['duplicate generated ID', room(), [HOST_ID]],
    [
      'join-order overflow',
      room({ players: [player(HOST_ID, 'Alex', Number.MAX_SAFE_INTEGER)] }),
      [JOINER_ID],
    ],
    [
      'revision overflow',
      room({ revision: Number.MAX_SAFE_INTEGER }),
      [JOINER_ID],
    ],
  ] as const) {
    it(`sanitizes ${name} without mutation`, () => {
      const setup = harness({ initialRoom, identifiers });
      const before = setup.repository.getByCode('ABC234');
      const response = setup.service.join('socket', JOIN_COMMAND);
      assert.equal(response.status, 'error');
      if (response.status === 'error')
        assert.equal(response.code, 'INTERNAL_ERROR');
      assert.equal(setup.repository.getByCode('ABC234'), before);
      assert.equal(setup.connectionRegistry.get('socket'), undefined);
      assert.equal(setup.receiptStore.get(JOIN_ID), undefined);
    });
  }

  it('rolls back exactly on projection, acknowledgement, and receipt failures', () => {
    const failures = [
      {
        projectSnapshot: () => {
          throw new Error('projection detail');
        },
      },
      { parseSuccess: () => undefined },
    ];
    for (const failure of failures) {
      const setup = harness({ initialRoom: room(), ...failure });
      const previous = setup.repository.getByCode('ABC234');
      const response = setup.service.join('socket', JOIN_COMMAND);
      assert.equal(response.status, 'error');
      assert.deepEqual(setup.repository.getByCode('ABC234'), previous);
      assert.equal(setup.connectionRegistry.get('socket'), undefined);
      assert.equal(setup.receiptStore.get(JOIN_ID), undefined);
    }

    const store = createLobbyCommandReceiptStore();
    const failingStore = {
      get: store.get,
      insert: () => {
        throw new Error('receipt');
      },
    };
    const setup = harness({ initialRoom: room(), receiptStore: failingStore });
    const previous = setup.repository.getByCode('ABC234');
    const response = setup.service.join('socket', JOIN_COMMAND);
    assert.equal(response.status, 'error');
    assert.deepEqual(setup.repository.getByCode('ABC234'), previous);
  });

  it('maps constructed-state failures precisely', () => {
    const setup = harness({
      initialRoom: room(),
      validateRoom: () => {
        throw new LobbyInvariantError('internal detail');
      },
    });
    const response = setup.service.join('socket', JOIN_COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'INVALID_LOBBY_STATE');
      assert.equal(response.message.includes('internal'), false);
    }
  });

  it('restores the room when binding fails before inserting a binding', () => {
    const baseRepository = createInMemoryLobbyRepository();
    const previous = baseRepository.insert(room());
    let unbindCalls = 0;
    const receiptStore = createLobbyCommandReceiptStore();
    const service = createJoinRoomService({
      repository: baseRepository,
      connectionRegistry: {
        get: () => undefined,
        bind: () => {
          throw new Error('binding failed');
        },
        unbindForRollback: () => {
          unbindCalls += 1;
          return true;
        },
      },
      receiptStore,
      generateIdentifier: () => JOINER_ID,
    });

    const response = service.join('socket', JOIN_COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'INTERNAL_ERROR');
    }
    assert.equal(unbindCalls, 1);
    assert.deepEqual(baseRepository.getByCode('ABC234'), previous);
    assert.notEqual(baseRepository.getByCode('ABC234'), previous);
    assert.equal(receiptStore.get(JOIN_ID), undefined);
  });

  it('attempts both cleanup operations and sanitizes cleanup failures', () => {
    const baseRepository = createInMemoryLobbyRepository();
    const previous = baseRepository.insert(room());
    let restoreCalls = 0;
    const repository: LobbyRepository = {
      ...baseRepository,
      restoreRoomForRollback: (input) => {
        restoreCalls += 1;
        return baseRepository.restoreRoomForRollback(input);
      },
    };
    let unbindCalls = 0;
    const receiptStore = createLobbyCommandReceiptStore();
    const service = createJoinRoomService({
      repository,
      connectionRegistry: {
        get: () => undefined,
        bind: () => undefined,
        unbindForRollback: () => {
          unbindCalls += 1;
          throw new Error('cleanup detail');
        },
      },
      receiptStore,
      generateIdentifier: () => JOINER_ID,
      projectSnapshot: () => {
        throw new Error('projection detail');
      },
    });

    const response = service.join('socket', JOIN_COMMAND);
    assert.deepEqual(response, {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Room join failed',
      commandId: JOIN_ID,
    });
    assert.equal(unbindCalls, 1);
    assert.equal(restoreCalls, 1);
    assert.deepEqual(repository.getByCode('ABC234'), previous);
    assert.equal(receiptStore.get(JOIN_ID), undefined);
  });

  it('sanitizes replacement failures without leaving side effects', () => {
    const baseRepository = createInMemoryLobbyRepository();
    const previous = baseRepository.insert(room());
    const repository: LobbyRepository = {
      ...baseRepository,
      replaceRoom: () => {
        throw new Error('replacement detail');
      },
    };
    const setup = harness({ repository });
    const response = setup.service.join('socket', JOIN_COMMAND);
    assert.deepEqual(response, {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Room join failed',
      commandId: JOIN_ID,
    });
    assert.equal(repository.getByCode('ABC234'), previous);
    assert.equal(setup.connectionRegistry.get('socket'), undefined);
    assert.equal(setup.receiptStore.get(JOIN_ID), undefined);
  });

  it('serializes final-seat, equivalent-name, and command competitions', () => {
    const finalSeat = harness({
      initialRoom: room({
        players: [
          player(HOST_ID, 'Alex', 0),
          player(THIRD_ID, 'Casey', 1),
          player(FOURTH_ID, 'Devon', 2),
        ],
      }),
      identifiers: [JOINER_ID, '99999999-9999-4999-8999-999999999999'],
    });
    assert.equal(finalSeat.service.join('one', JOIN_COMMAND).status, 'ok');
    const full = finalSeat.service.join('two', {
      ...JOIN_COMMAND,
      commandId: SECOND_JOIN_ID,
      displayName: 'Emery',
    });
    assert.equal(full.status, 'error');
    if (full.status === 'error') assert.equal(full.code, 'ROOM_FULL');

    const names = harness({
      initialRoom: room(),
      identifiers: [JOINER_ID, THIRD_ID],
    });
    assert.equal(names.service.join('one', JOIN_COMMAND).status, 'ok');
    const duplicate = names.service.join('two', {
      ...JOIN_COMMAND,
      commandId: SECOND_JOIN_ID,
      displayName: 'Ｂｌａｉｒ',
    });
    assert.equal(duplicate.status, 'error');
    if (duplicate.status === 'error')
      assert.equal(duplicate.code, 'NAME_TAKEN');
  });
});
