import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  CreateRoomCommand,
  PlayerId,
  SeatIndex,
  SetSeatCommand,
} from '@guandan/protocol';

import { createLobbyCommandReceiptStore } from '../src/lobby/command-receipts.js';
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
import { createSetSeatService } from '../src/lobby/set-seat.js';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const THIRD_ID = '44444444-4444-4444-8444-444444444444';
const COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_COMMAND_ID = '66666666-6666-4666-8666-666666666666';
const CREATE_ID = '77777777-7777-4777-8777-777777777777';

const COMMAND: SetSeatCommand = {
  commandId: COMMAND_ID,
  knownRevision: 4,
  seat: 2,
};

function player(
  playerId: PlayerId,
  name: string,
  joinOrder: number,
  overrides: Partial<LobbyPlayerState> = {},
): LobbyPlayerState {
  return {
    playerId,
    displayName: name,
    displayNameKey: name.toLocaleLowerCase('en-US'),
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
    revision: 4,
    phase: 'lobby',
    hostPlayerId: HOST_ID,
    settings: { startingLevel: 2, turnTimer: 'off', hasPassword: false },
    players: [
      player(HOST_ID, 'Alex', 0, { seat: 0 }),
      player(MEMBER_ID, 'Blair', 1),
    ],
    ...overrides,
  };
}

function changedRoom(
  current: LobbyRoomState,
  actorId: PlayerId,
  seat: SeatIndex | null,
): LobbyRoomState {
  return {
    ...current,
    revision: current.revision + 1,
    players: current.players.map((entry) =>
      entry.playerId === actorId
        ? { ...entry, seat, ready: false }
        : { ...entry },
    ),
  };
}

function harness(
  options: {
    initialRoom?: LobbyRoomState;
    repository?: LobbyRepository;
    bind?: boolean;
    socketId?: string;
    playerId?: PlayerId;
    receiptStore?: ReturnType<typeof createLobbyCommandReceiptStore>;
    projectSnapshot?: Parameters<
      typeof createSetSeatService
    >[0]['projectSnapshot'];
    parseSuccess?: Parameters<typeof createSetSeatService>[0]['parseSuccess'];
    validateRoom?: Parameters<typeof createSetSeatService>[0]['validateRoom'];
  } = {},
) {
  const repository = options.repository ?? createInMemoryLobbyRepository();
  const initialRoom = options.initialRoom ?? room();
  if (repository.getById(initialRoom.roomId) === undefined) {
    repository.insert(initialRoom);
  }
  const connectionRegistry = createLobbyConnectionRegistry();
  const socketId = options.socketId ?? 'member-socket';
  if (options.bind ?? true) {
    connectionRegistry.bind(socketId, {
      roomId: initialRoom.roomId,
      playerId: options.playerId ?? MEMBER_ID,
    });
  }
  const receiptStore = options.receiptStore ?? createLobbyCommandReceiptStore();
  const service = createSetSeatService({
    repository,
    connectionRegistry,
    receiptStore,
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
  return { repository, connectionRegistry, receiptStore, service, socketId };
}

describe('seat-selection repository replacement', () => {
  it('stores an immutable seat change and returns the exact previous room', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(
      room({
        players: [
          player(HOST_ID, 'Alex', 0, { seat: 0, ready: true }),
          player(MEMBER_ID, 'Blair', 1, { seat: 1, ready: true }),
        ],
      }),
    );
    const callerNext = changedRoom(previous, MEMBER_ID, 2);
    const replacement = repository.replaceRoomForSeatSelection({
      roomId: ROOM_ID,
      expectedRevision: 4,
      actingPlayerId: MEMBER_ID,
      expectedCurrentSeat: 1,
      requestedNextSeat: 2,
      nextRoom: callerNext,
    });

    assert.equal(replacement.previousRoom, previous);
    assert.equal(repository.getById(ROOM_ID), replacement.storedRoom);
    assert.equal(repository.getByCode('ABC234'), replacement.storedRoom);
    assert.equal(repository.count(), 1);
    assert.equal(replacement.storedRoom.revision, 5);
    assert.deepEqual(
      replacement.storedRoom.players.map((entry) => entry.playerId),
      [HOST_ID, MEMBER_ID],
    );
    assert.deepEqual(replacement.storedRoom.players[0], previous.players[0]);
    assert.deepEqual(replacement.storedRoom.players[1], {
      ...previous.players[1],
      seat: 2,
      ready: false,
    });
    callerNext.players[1]!.displayName = 'Changed';
    assert.equal(replacement.storedRoom.players[1]?.displayName, 'Blair');
    assert.equal(Object.isFrozen(replacement.storedRoom), true);
    assert.equal(Object.isFrozen(replacement.storedRoom.settings), true);
    assert.equal(Object.isFrozen(replacement.storedRoom.players), true);
    assert.equal(Object.isFrozen(replacement.storedRoom.players[1]), true);
  });

  for (const [name, mutate, overrides] of [
    ['room ID', (next: LobbyRoomState) => ({ ...next, roomId: THIRD_ID }), {}],
    [
      'room code',
      (next: LobbyRoomState) => ({ ...next, roomCode: 'DEF567' }),
      {},
    ],
    ['phase', (next: LobbyRoomState) => ({ ...next, phase: 'match' }), {}],
    [
      'host',
      (next: LobbyRoomState) => ({ ...next, hostPlayerId: MEMBER_ID }),
      {},
    ],
    [
      'settings',
      (next: LobbyRoomState) => ({
        ...next,
        settings: { ...next.settings, startingLevel: 7 },
      }),
      {},
    ],
    [
      'player addition',
      (next: LobbyRoomState) => ({
        ...next,
        players: [...next.players, player(THIRD_ID, 'Casey', 2)],
      }),
      {},
    ],
    [
      'player removal',
      (next: LobbyRoomState) => ({ ...next, players: next.players.slice(1) }),
      {},
    ],
    [
      'player reorder',
      (next: LobbyRoomState) => ({
        ...next,
        players: [...next.players].reverse(),
      }),
      {},
    ],
    [
      'other player',
      (next: LobbyRoomState) => ({
        ...next,
        players: next.players.map((entry) =>
          entry.playerId === HOST_ID ? { ...entry, ready: true } : entry,
        ),
      }),
      {},
    ],
    [
      'acting player name',
      (next: LobbyRoomState) => ({
        ...next,
        players: next.players.map((entry) =>
          entry.playerId === MEMBER_ID
            ? { ...entry, displayName: 'Changed', displayNameKey: 'changed' }
            : entry,
        ),
      }),
      {},
    ],
    [
      'acting player join order',
      (next: LobbyRoomState) => ({
        ...next,
        players: next.players.map((entry) =>
          entry.playerId === MEMBER_ID ? { ...entry, joinOrder: 9 } : entry,
        ),
      }),
      {},
    ],
    [
      'acting player connection',
      (next: LobbyRoomState) => ({
        ...next,
        players: next.players.map((entry) =>
          entry.playerId === MEMBER_ID
            ? { ...entry, connectionStatus: 'disconnected' }
            : entry,
        ),
      }),
      {},
    ],
    [
      'revision reuse',
      (next: LobbyRoomState) => ({ ...next, revision: 4 }),
      {},
    ],
    ['revision jump', (next: LobbyRoomState) => ({ ...next, revision: 6 }), {}],
    [
      'wrong old seat',
      (next: LobbyRoomState) => next,
      { expectedCurrentSeat: 1 },
    ],
    [
      'wrong next seat',
      (next: LobbyRoomState) => next,
      { requestedNextSeat: 3 },
    ],
    [
      'missing actor',
      (next: LobbyRoomState) => next,
      { actingPlayerId: THIRD_ID },
    ],
  ] as const) {
    it(`rejects ${name} changes`, () => {
      const repository = createInMemoryLobbyRepository();
      const previous = repository.insert(room());
      const next = mutate(
        changedRoom(previous, MEMBER_ID, 2),
      ) as LobbyRoomState;
      assert.throws(() =>
        repository.replaceRoomForSeatSelection({
          roomId: ROOM_ID,
          expectedRevision: 4,
          actingPlayerId: MEMBER_ID,
          expectedCurrentSeat: null,
          requestedNextSeat: 2,
          nextRoom: next,
          ...overrides,
        }),
      );
      assert.equal(repository.getById(ROOM_ID), previous);
    });
  }

  it('rejects stale replacement, no-op replacement, and revision overflow', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    assert.throws(
      () =>
        repository.replaceRoomForSeatSelection({
          roomId: ROOM_ID,
          expectedRevision: 3,
          actingPlayerId: MEMBER_ID,
          expectedCurrentSeat: null,
          requestedNextSeat: 2,
          nextRoom: changedRoom(previous, MEMBER_ID, 2),
        }),
      (error) =>
        error instanceof LobbyRepositoryReplaceError &&
        error.failure === 'revision-mismatch',
    );
    assert.throws(
      () =>
        repository.replaceRoomForSeatSelection({
          roomId: ROOM_ID,
          expectedRevision: 4,
          actingPlayerId: MEMBER_ID,
          expectedCurrentSeat: null,
          requestedNextSeat: null,
          nextRoom: previous,
        }),
      (error) =>
        error instanceof LobbyRepositoryReplaceError &&
        error.failure === 'seat-no-op',
    );

    const overflowRepository = createInMemoryLobbyRepository();
    const overflow = overflowRepository.insert(
      room({ revision: Number.MAX_SAFE_INTEGER }),
    );
    assert.throws(
      () =>
        overflowRepository.replaceRoomForSeatSelection({
          roomId: ROOM_ID,
          expectedRevision: Number.MAX_SAFE_INTEGER,
          actingPlayerId: MEMBER_ID,
          expectedCurrentSeat: null,
          requestedNextSeat: 2,
          nextRoom: { ...overflow, players: [...overflow.players] },
        }),
      (error) =>
        error instanceof LobbyRepositoryReplaceError &&
        error.failure === 'revision-overflow',
    );
  });

  it('independently rejects occupied next state', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(
      room({
        players: [
          player(HOST_ID, 'Alex', 0, { seat: 2 }),
          player(MEMBER_ID, 'Blair', 1),
        ],
      }),
    );
    assert.throws(() =>
      repository.replaceRoomForSeatSelection({
        roomId: ROOM_ID,
        expectedRevision: 4,
        actingPlayerId: MEMBER_ID,
        expectedCurrentSeat: null,
        requestedNextSeat: 2,
        nextRoom: changedRoom(previous, MEMBER_ID, 2),
      }),
    );
    assert.equal(repository.getById(ROOM_ID), previous);
  });

  it('restores exact state once and isolates join from seat rollback', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    const replacement = repository.replaceRoomForSeatSelection({
      roomId: ROOM_ID,
      expectedRevision: 4,
      actingPlayerId: MEMBER_ID,
      expectedCurrentSeat: null,
      requestedNextSeat: 2,
      nextRoom: changedRoom(previous, MEMBER_ID, 2),
    });

    assert.throws(() =>
      repository.restoreRoomForRollback({
        roomId: ROOM_ID,
        expectedCurrentRevision: 5,
        previousRoom: previous,
      }),
    );
    const restored = repository.restoreRoomForSeatSelectionRollback({
      roomId: ROOM_ID,
      expectedCurrentRevision: 5,
      previousRoom: previous,
    });
    assert.equal(restored, previous);
    assert.equal(repository.getByCode('ABC234'), previous);
    assert.throws(() =>
      repository.restoreRoomForSeatSelectionRollback({
        roomId: ROOM_ID,
        expectedCurrentRevision: 5,
        previousRoom: previous,
      }),
    );
    assert.notEqual(replacement.storedRoom, previous);
  });

  it('rejects reconstructed prior state and newer replacements', () => {
    const repository = createInMemoryLobbyRepository();
    const previous = repository.insert(room());
    const first = repository.replaceRoomForSeatSelection({
      roomId: ROOM_ID,
      expectedRevision: 4,
      actingPlayerId: MEMBER_ID,
      expectedCurrentSeat: null,
      requestedNextSeat: 2,
      nextRoom: changedRoom(previous, MEMBER_ID, 2),
    });
    const reconstructed: LobbyRoomState = {
      ...previous,
      settings: { ...previous.settings },
      players: previous.players.map((entry) => ({ ...entry })),
    };
    assert.throws(() =>
      repository.restoreRoomForSeatSelectionRollback({
        roomId: ROOM_ID,
        expectedCurrentRevision: 5,
        previousRoom: reconstructed,
      }),
    );
    const second = repository.replaceRoomForSeatSelection({
      roomId: ROOM_ID,
      expectedRevision: 5,
      actingPlayerId: MEMBER_ID,
      expectedCurrentSeat: 2,
      requestedNextSeat: 3,
      nextRoom: changedRoom(first.storedRoom, MEMBER_ID, 3),
    });
    assert.throws(() =>
      repository.restoreRoomForSeatSelectionRollback({
        roomId: ROOM_ID,
        expectedCurrentRevision: 5,
        previousRoom: previous,
      }),
    );
    assert.equal(repository.getById(ROOM_ID), second.storedRoom);
  });
});

describe('authoritative set-seat service', () => {
  it('selects, moves, and clears only the bound player seat', () => {
    const setup = harness();
    const selected = setup.service.setSeat(setup.socketId, COMMAND);
    assert.equal(selected.status, 'ok');
    if (selected.status !== 'ok') return;
    assert.equal(selected.roomRevision, 5);
    assert.equal(selected.snapshot.selfPlayerId, MEMBER_ID);
    assert.equal(
      selected.snapshot.players.find((entry) => entry.playerId === MEMBER_ID)
        ?.seat,
      2,
    );
    assert.equal(setup.repository.getById(ROOM_ID)?.players[0]?.seat, 0);

    const moved = setup.service.setSeat(setup.socketId, {
      commandId: SECOND_COMMAND_ID,
      knownRevision: 5,
      seat: 3,
    });
    assert.equal(moved.status, 'ok');
    const cleared = setup.service.setSeat(setup.socketId, {
      commandId: '88888888-8888-4888-8888-888888888888',
      knownRevision: 6,
      seat: null,
    });
    assert.equal(cleared.status, 'ok');
    if (cleared.status === 'ok') {
      assert.equal(cleared.roomRevision, 7);
      assert.equal(
        cleared.snapshot.players.find((entry) => entry.isSelf)?.seat,
        null,
      );
    }
  });

  it('lets hosts and non-hosts select only themselves', () => {
    const host = harness({ socketId: 'host', playerId: HOST_ID });
    const hostResult = host.service.setSeat('host', {
      commandId: COMMAND_ID,
      knownRevision: 4,
      seat: 1,
    });
    assert.equal(hostResult.status, 'ok');
    assert.equal(host.repository.getById(ROOM_ID)?.players[1]?.seat, null);

    const member = harness();
    const memberResult = member.service.setSeat('member-socket', COMMAND);
    assert.equal(memberResult.status, 'ok');
    assert.equal(member.repository.getById(ROOM_ID)?.players[0]?.seat, 0);
  });

  it('resets acting readiness on change and preserves every other player', () => {
    const initial = room({
      players: [
        player(HOST_ID, 'Alex', 0, { seat: 0, ready: true }),
        player(MEMBER_ID, 'Blair', 1, { seat: 1, ready: true }),
      ],
    });
    const setup = harness({ initialRoom: initial });
    const previous = setup.repository.getById(ROOM_ID)!;
    const response = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(response.status, 'ok');
    const stored = setup.repository.getById(ROOM_ID)!;
    assert.deepEqual(stored.players[0], previous.players[0]);
    assert.deepEqual(stored.players[1], {
      ...previous.players[1],
      seat: 2,
      ready: false,
    });
  });

  it('preserves ready true on a same occupied-seat no-op', () => {
    const setup = harness({
      initialRoom: room({
        players: [
          player(HOST_ID, 'Alex', 0, { seat: 0, ready: true }),
          player(MEMBER_ID, 'Blair', 1, { seat: 2, ready: true }),
        ],
      }),
    });
    const previous = setup.repository.getById(ROOM_ID);
    const response = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(response.status, 'ok');
    if (response.status === 'ok') {
      assert.equal(response.roomRevision, 4);
      assert.equal(
        response.snapshot.players.find((entry) => entry.isSelf)?.ready,
        true,
      );
    }
    assert.equal(setup.repository.getById(ROOM_ID), previous);
    assert.equal(setup.repository.getById(ROOM_ID)?.players[1]?.ready, true);
  });

  it('stores an immutable caller-safe set-seat receipt', () => {
    const setup = harness();
    const command = { ...COMMAND };
    const response = setup.service.setSeat('member-socket', command);
    assert.equal(response.status, 'ok');
    if (response.status !== 'ok') return;

    const receipt = setup.receiptStore.get(COMMAND_ID);
    assert.notEqual(receipt, undefined);
    assert.equal(receipt?.commandKind, 'set-seat');
    if (receipt?.commandKind !== 'set-seat') return;
    assert.notEqual(receipt.command, command);
    assert.equal(receipt.success, response);
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(Object.isFrozen(receipt.command), true);
    assert.equal(Object.isFrozen(receipt.success), true);
    assert.equal(Object.isFrozen(receipt.success.snapshot), true);
    assert.equal(Object.isFrozen(receipt.success.snapshot.players), true);
    assert.equal(Object.isFrozen(receipt.success.snapshot.players[0]), true);
    assert.equal(
      Object.isFrozen(receipt.success.snapshot.startEligibility.blockers),
      true,
    );

    command.seat = 3;
    assert.equal(receipt.command.seat, 2);
    assert.throws(() => {
      (receipt.command as { seat: SeatIndex | null }).seat = 1;
    }, TypeError);
  });

  it('treats null-to-null as a receipt-backed no-op without replacement', () => {
    const base = createInMemoryLobbyRepository();
    const previous = base.insert(room());
    let replacements = 0;
    const repository: LobbyRepository = {
      ...base,
      replaceRoomForSeatSelection: (input) => {
        replacements += 1;
        return base.replaceRoomForSeatSelection(input);
      },
    };
    const setup = harness({ repository });
    const command = { ...COMMAND, seat: null };
    const first = setup.service.setSeat('member-socket', command);
    const replay = setup.service.setSeat('member-socket', command);
    assert.equal(first.status, 'ok');
    assert.equal(replay, first);
    assert.equal(replacements, 0);
    assert.equal(repository.getById(ROOM_ID), previous);
    assert.equal(setup.receiptStore.get(COMMAND_ID)?.commandKind, 'set-seat');
  });

  it('checks stale revision before occupancy, then reports SEAT_TAKEN', () => {
    const setup = harness({
      initialRoom: room({
        revision: 5,
        players: [
          player(HOST_ID, 'Alex', 0, { seat: 2 }),
          player(MEMBER_ID, 'Blair', 1),
        ],
      }),
    });
    const stale = setup.service.setSeat('member-socket', COMMAND);
    assert.deepEqual(stale, {
      status: 'error',
      code: 'STALE_REVISION',
      message: 'Room revision is stale',
      commandId: COMMAND_ID,
      currentRevision: 5,
    });
    const taken = setup.service.setSeat('member-socket', {
      ...COMMAND,
      knownRevision: 5,
    });
    assert.deepEqual(taken, {
      status: 'error',
      code: 'SEAT_TAKEN',
      message: 'Requested seat is already occupied',
      commandId: COMMAND_ID,
    });
    assert.equal(setup.repository.getById(ROOM_ID)?.revision, 5);
    assert.equal(setup.receiptStore.get(COMMAND_ID), undefined);
  });

  it('returns command-bearing membership and internal-state errors', () => {
    const unbound = harness({ bind: false });
    assert.deepEqual(unbound.service.setSeat('member-socket', COMMAND), {
      status: 'error',
      code: 'NOT_ROOM_MEMBER',
      message: 'Connection is not bound to a lobby',
      commandId: COMMAND_ID,
    });

    const missingRoomRepository = createInMemoryLobbyRepository();
    const missingRoomRegistry = createLobbyConnectionRegistry();
    missingRoomRegistry.bind('socket', {
      roomId: ROOM_ID,
      playerId: MEMBER_ID,
    });
    const missingRoomService = createSetSeatService({
      repository: missingRoomRepository,
      connectionRegistry: missingRoomRegistry,
      receiptStore: createLobbyCommandReceiptStore(),
    });
    assert.equal(
      (missingRoomService.setSeat('socket', COMMAND) as { code: string }).code,
      'INTERNAL_ERROR',
    );

    const missingPlayer = harness({ playerId: THIRD_ID });
    const response = missingPlayer.service.setSeat('member-socket', COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error') {
      assert.equal(response.code, 'INTERNAL_ERROR');
      assert.equal(response.commandId, COMMAND_ID);
    }
  });

  it('parses before receipt lookup and replays exactly before all state checks', () => {
    const setup = harness();
    const first = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(first.status, 'ok');
    const advanced = setup.service.setSeat('member-socket', {
      commandId: SECOND_COMMAND_ID,
      knownRevision: 5,
      seat: 3,
    });
    assert.equal(advanced.status, 'ok');

    setup.connectionRegistry.unbindForRollback('member-socket', {
      roomId: ROOM_ID,
      playerId: MEMBER_ID,
    });
    const replay = setup.service.setSeat('member-socket', { ...COMMAND });
    assert.equal(replay, first);

    const malformed = setup.service.setSeat('member-socket', {
      ...COMMAND,
      extra: true,
    });
    assert.equal(malformed.status, 'error');
    if (malformed.status === 'error')
      assert.equal(malformed.code, 'INVALID_PAYLOAD');
  });

  it('rejects set-seat payload, revision, socket, and cross-kind command conflicts', () => {
    const setup = harness();
    const first = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(first.status, 'ok');
    for (const [socketId, command] of [
      ['member-socket', { ...COMMAND, seat: 3 }],
      ['member-socket', { ...COMMAND, knownRevision: 5 }],
      ['other-socket', COMMAND],
    ] as const) {
      const response = setup.service.setSeat(socketId, command);
      assert.equal(response.status, 'error');
      if (response.status === 'error') {
        assert.equal(response.code, 'COMMAND_ID_CONFLICT');
      }
    }

    const repository = createInMemoryLobbyRepository();
    const registry = createLobbyConnectionRegistry();
    const receipts = createLobbyCommandReceiptStore();
    const createCommand: CreateRoomCommand = {
      commandId: CREATE_ID,
      displayName: 'Casey',
      settings: { startingLevel: 2, turnTimer: 'off' },
    };
    const identifiers = [THIRD_ID, '99999999-9999-4999-8999-999999999999'];
    createCreateRoomService({
      repository,
      roomCodeAllocator: createRoomCodeAllocator(repository, () => 'DEF567'),
      connectionRegistry: registry,
      receiptStore: receipts,
      generateIdentifier: () => identifiers.shift()!,
    }).create('creator', createCommand);
    const seatService = createSetSeatService({
      repository,
      connectionRegistry: registry,
      receiptStore: receipts,
    });
    const conflict = seatService.setSeat('creator', {
      commandId: CREATE_ID,
      knownRevision: 0,
      seat: 1,
    });
    assert.equal(conflict.status, 'error');
    if (conflict.status === 'error')
      assert.equal(conflict.code, 'COMMAND_ID_CONFLICT');
  });

  it('blocks create and join commands from reusing a set-seat command ID', () => {
    const setup = harness();
    const selected = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(selected.status, 'ok');

    let generatedIdentifiers = 0;
    const createResult = createCreateRoomService({
      repository: setup.repository,
      roomCodeAllocator: createRoomCodeAllocator(
        setup.repository,
        () => 'DEF567',
      ),
      connectionRegistry: setup.connectionRegistry,
      receiptStore: setup.receiptStore,
      generateIdentifier: () => {
        generatedIdentifiers += 1;
        return THIRD_ID;
      },
    }).create('creator', {
      commandId: COMMAND_ID,
      displayName: 'Casey',
      settings: { startingLevel: 2, turnTimer: 'off' },
    });
    assert.equal(createResult.status, 'error');
    if (createResult.status === 'error') {
      assert.equal(createResult.code, 'COMMAND_ID_CONFLICT');
    }
    assert.equal(generatedIdentifiers, 0);

    const joinResult = createJoinRoomService({
      repository: setup.repository,
      connectionRegistry: setup.connectionRegistry,
      receiptStore: setup.receiptStore,
      generateIdentifier: () => {
        generatedIdentifiers += 1;
        return THIRD_ID;
      },
    }).join('joiner', {
      commandId: COMMAND_ID,
      roomCode: 'ABC234',
      displayName: 'Casey',
    });
    assert.equal(joinResult.status, 'error');
    if (joinResult.status === 'error') {
      assert.equal(joinResult.code, 'COMMAND_ID_CONFLICT');
    }
    assert.equal(generatedIdentifiers, 0);
  });

  it('rolls back exact state after projection, validation, and receipt failures', () => {
    for (const failure of [
      {
        projectSnapshot: () => {
          throw new Error('projection detail');
        },
      },
      { parseSuccess: () => undefined },
    ]) {
      const setup = harness(failure);
      const previous = setup.repository.getById(ROOM_ID);
      const response = setup.service.setSeat('member-socket', COMMAND);
      assert.equal(response.status, 'error');
      if (response.status === 'error') {
        assert.equal(response.code, 'INVALID_LOBBY_STATE');
        assert.equal(response.commandId, COMMAND_ID);
      }
      assert.equal(setup.repository.getById(ROOM_ID), previous);
      assert.equal(setup.receiptStore.get(COMMAND_ID), undefined);
      assert.deepEqual(setup.connectionRegistry.get('member-socket'), {
        roomId: ROOM_ID,
        playerId: MEMBER_ID,
      });
    }

    const store = createLobbyCommandReceiptStore();
    const failingStore = {
      get: store.get,
      insert: () => {
        throw new Error('receipt detail');
      },
    };
    const setup = harness({ receiptStore: failingStore });
    const previous = setup.repository.getById(ROOM_ID);
    const response = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(response.status, 'error');
    if (response.status === 'error')
      assert.equal(response.code, 'INTERNAL_ERROR');
    assert.equal(setup.repository.getById(ROOM_ID), previous);
  });

  it('maps constructed invalid state and rollback failures without detail', () => {
    const invalid = harness({
      validateRoom: (value) => {
        if (value.revision === 5) throw new LobbyInvariantError('detail');
      },
    });
    const invalidResponse = invalid.service.setSeat('member-socket', COMMAND);
    assert.equal(invalidResponse.status, 'error');
    if (invalidResponse.status === 'error') {
      assert.equal(invalidResponse.code, 'INVALID_LOBBY_STATE');
      assert.equal(invalidResponse.message.includes('detail'), false);
    }

    const rejectingBase = createInMemoryLobbyRepository();
    rejectingBase.insert(room());
    const rejectingRepository: LobbyRepository = {
      ...rejectingBase,
      replaceRoomForSeatSelection: () => {
        throw new LobbyInvariantError('repository detail');
      },
    };
    const rejected = harness({ repository: rejectingRepository });
    const rejectedResponse = rejected.service.setSeat('member-socket', COMMAND);
    assert.equal(rejectedResponse.status, 'error');
    if (rejectedResponse.status === 'error') {
      assert.equal(rejectedResponse.code, 'INTERNAL_ERROR');
      assert.equal(rejectedResponse.commandId, COMMAND_ID);
      assert.equal(rejectedResponse.message.includes('detail'), false);
    }

    const base = createInMemoryLobbyRepository();
    base.insert(room());
    const repository: LobbyRepository = {
      ...base,
      restoreRoomForSeatSelectionRollback: () => {
        throw new Error('rollback detail');
      },
    };
    const failed = harness({
      repository,
      projectSnapshot: () => {
        throw new Error('projection detail');
      },
    });
    const rollbackResponse = failed.service.setSeat('member-socket', COMMAND);
    assert.equal(rollbackResponse.status, 'error');
    if (rollbackResponse.status === 'error') {
      assert.equal(rollbackResponse.code, 'INTERNAL_ERROR');
      assert.equal(rollbackResponse.message.includes('detail'), false);
    }
  });

  it('serializes competing seat and command-ID operations synchronously', () => {
    const initial = room({
      players: [
        player(HOST_ID, 'Alex', 0),
        player(MEMBER_ID, 'Blair', 1),
        player(THIRD_ID, 'Casey', 2),
      ],
    });
    const setup = harness({ initialRoom: initial });
    setup.connectionRegistry.bind('third', {
      roomId: ROOM_ID,
      playerId: THIRD_ID,
    });

    const first = setup.service.setSeat('member-socket', COMMAND);
    assert.equal(first.status, 'ok');
    const stale = setup.service.setSeat('third', {
      commandId: SECOND_COMMAND_ID,
      knownRevision: 4,
      seat: 2,
    });
    assert.equal(stale.status, 'error');
    if (stale.status === 'error') assert.equal(stale.code, 'STALE_REVISION');
    const taken = setup.service.setSeat('third', {
      commandId: SECOND_COMMAND_ID,
      knownRevision: 5,
      seat: 2,
    });
    assert.equal(taken.status, 'error');
    if (taken.status === 'error') assert.equal(taken.code, 'SEAT_TAKEN');

    const sameRevision = setup.service.setSeat('member-socket', {
      commandId: '99999999-9999-4999-8999-999999999999',
      knownRevision: 4,
      seat: 3,
    });
    assert.equal(sameRevision.status, 'error');
    if (sameRevision.status === 'error')
      assert.equal(sameRevision.code, 'STALE_REVISION');

    const sharedIdFirst = setup.service.setSeat('member-socket', {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      knownRevision: 5,
      seat: 3,
    });
    assert.equal(sharedIdFirst.status, 'ok');
    const sharedIdSecond = setup.service.setSeat('third', {
      commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      knownRevision: 6,
      seat: 1,
    });
    assert.equal(sharedIdSecond.status, 'error');
    if (sharedIdSecond.status === 'error') {
      assert.equal(sharedIdSecond.code, 'COMMAND_ID_CONFLICT');
    }
  });

  it('sanitizes revision overflow without mutation or receipt', () => {
    const setup = harness({
      initialRoom: room({ revision: Number.MAX_SAFE_INTEGER }),
    });
    const previous = setup.repository.getById(ROOM_ID);
    const response = setup.service.setSeat('member-socket', {
      ...COMMAND,
      knownRevision: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(response.status, 'error');
    if (response.status === 'error')
      assert.equal(response.code, 'INTERNAL_ERROR');
    assert.equal(setup.repository.getById(ROOM_ID), previous);
    assert.equal(setup.receiptStore.get(COMMAND_ID), undefined);
  });
});
