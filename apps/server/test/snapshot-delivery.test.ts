import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveDisplayNameKey,
  parseLobbySnapshotV1,
  type PlayerId,
} from '@guandan/protocol';

import {
  createLobbyConnectionRegistry,
  type LobbyConnectionRegistry,
} from '../src/lobby/connection-registry.js';
import type { LobbyPlayerState, LobbyRoomState } from '../src/lobby/model.js';
import { createInMemoryLobbyRepository } from '../src/lobby/repository.js';
import { createLobbySnapshotDeliveryPlanner } from '../src/lobby/snapshot-delivery.js';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ROOM_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_ID = '44444444-4444-4444-8444-444444444444';
const THIRD_ID = '55555555-5555-4555-8555-555555555555';
const FOURTH_ID = '66666666-6666-4666-8666-666666666666';
const UNKNOWN_ID = '77777777-7777-4777-8777-777777777777';

function player(
  playerId: PlayerId,
  displayName: string,
  joinOrder: number,
  overrides: Partial<LobbyPlayerState> = {},
): LobbyPlayerState {
  const displayNameKey = deriveDisplayNameKey(displayName);
  assert.notEqual(displayNameKey, undefined);
  return {
    playerId,
    displayName,
    displayNameKey: displayNameKey!,
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
    revision: 3,
    phase: 'lobby',
    hostPlayerId: HOST_ID,
    settings: { startingLevel: 2, turnTimer: 30, hasPassword: false },
    players: [
      player(FOURTH_ID, 'Devon', 3),
      player(SECOND_ID, 'Blair', 1, { seat: 3 }),
      player(HOST_ID, 'Alex', 0),
      player(THIRD_ID, 'Casey', 2, { seat: 1 }),
    ],
    ...overrides,
  };
}

function createPlanner(
  initialRoom: LobbyRoomState = room(),
  registry: LobbyConnectionRegistry = createLobbyConnectionRegistry(),
  projectSnapshot?: Parameters<
    typeof createLobbySnapshotDeliveryPlanner
  >[0]['projectSnapshot'],
) {
  const repository = createInMemoryLobbyRepository();
  repository.insert(initialRoom);
  return {
    registry,
    planner: createLobbySnapshotDeliveryPlanner({
      repository,
      connectionRegistry: registry,
      ...(projectSnapshot === undefined ? {} : { projectSnapshot }),
    }),
  };
}

function bindAll(registry: LobbyConnectionRegistry): void {
  registry.bind('socket-host', { roomId: ROOM_ID, playerId: HOST_ID });
  registry.bind('socket-two', { roomId: ROOM_ID, playerId: SECOND_ID });
  registry.bind('socket-three', { roomId: ROOM_ID, playerId: THIRD_ID });
  registry.bind('socket-four', { roomId: ROOM_ID, playerId: FOURTH_ID });
}

function findForbiddenKey(
  value: unknown,
  forbidden: ReadonlySet<string>,
): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForbiddenKey(entry, forbidden);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key)) return key;
    const found = findForbiddenKey(entry, forbidden);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe('lobby snapshot delivery planner', () => {
  it('plans every bound viewer in authoritative player order', () => {
    const setup = createPlanner();
    bindAll(setup.registry);

    const plan = setup.planner.prepare(ROOM_ID);
    assert.equal(plan.roomId, ROOM_ID);
    assert.equal(plan.revision, 3);
    assert.deepEqual(
      plan.deliveries.map((delivery) => delivery.playerId),
      [THIRD_ID, SECOND_ID, HOST_ID, FOURTH_ID],
    );
    assert.deepEqual(
      plan.deliveries.map((delivery) => delivery.socketId),
      ['socket-three', 'socket-two', 'socket-host', 'socket-four'],
    );
    for (const delivery of plan.deliveries) {
      assert.deepEqual(
        parseLobbySnapshotV1(delivery.snapshot),
        delivery.snapshot,
      );
      assert.equal(delivery.snapshot.revision, 3);
      assert.equal(delivery.snapshot.selfPlayerId, delivery.playerId);
      assert.equal(
        delivery.snapshot.players.filter((entry) => entry.isSelf).length,
        1,
      );
    }
    assert.equal(
      plan.deliveries.find((delivery) => delivery.playerId === HOST_ID)
        ?.snapshot.capabilities.canChangeSettings,
      true,
    );
    assert.equal(
      plan.deliveries.find((delivery) => delivery.playerId === SECOND_ID)
        ?.snapshot.capabilities.canChangeSettings,
      false,
    );
  });

  it('supports partial one-through-four-player active bindings', () => {
    for (let count = 1; count <= 4; count += 1) {
      const players = room().players.slice(0, count);
      const setup = createPlanner(
        room({
          hostPlayerId: players[0]!.playerId,
          players,
        }),
      );
      players.forEach((entry, index) => {
        setup.registry.bind(`socket-${index}`, {
          roomId: ROOM_ID,
          playerId: entry.playerId,
        });
      });
      assert.equal(setup.planner.prepare(ROOM_ID).deliveries.length, count);
    }
  });

  it('recursively excludes internal and command transport keys', () => {
    const setup = createPlanner();
    bindAll(setup.registry);
    const plan = setup.planner.prepare(ROOM_ID);
    const forbidden = new Set([
      'displayNameKey',
      'joinOrder',
      'socketId',
      'commandId',
    ]);
    for (const delivery of plan.deliveries) {
      assert.equal(findForbiddenKey(delivery.snapshot, forbidden), undefined);
      assert.equal(Object.hasOwn(delivery.snapshot, 'roomCode'), true);
      const snapshotWithoutProtocolRoomCode = { ...delivery.snapshot };
      delete (snapshotWithoutProtocolRoomCode as { roomCode?: string })
        .roomCode;
      assert.equal(
        findForbiddenKey(
          snapshotWithoutProtocolRoomCode,
          new Set(['roomCode']),
        ),
        undefined,
      );
    }
  });

  it('returns recursively frozen plans and snapshots', () => {
    const setup = createPlanner();
    bindAll(setup.registry);
    const plan = setup.planner.prepare(ROOM_ID);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.deliveries), true);
    assert.equal(Object.isFrozen(plan.deliveries[0]), true);
    assert.equal(Object.isFrozen(plan.deliveries[0]?.snapshot), true);
    assert.equal(Object.isFrozen(plan.deliveries[0]?.snapshot.players), true);
    assert.equal(
      Object.isFrozen(plan.deliveries[0]?.snapshot.players[0]),
      true,
    );
    assert.equal(
      Object.isFrozen(plan.deliveries[0]?.snapshot.startEligibility.blockers),
      true,
    );
  });

  it('keeps other-room bindings outside the plan', () => {
    const setup = createPlanner();
    setup.registry.bind('socket-host', { roomId: ROOM_ID, playerId: HOST_ID });
    setup.registry.bind('socket-other', {
      roomId: SECOND_ROOM_ID,
      playerId: UNKNOWN_ID,
    });
    assert.deepEqual(
      setup.planner.prepare(ROOM_ID).deliveries.map((entry) => entry.socketId),
      ['socket-host'],
    );
  });

  it('rejects unknown and duplicate player bindings', () => {
    const unknown = createPlanner();
    unknown.registry.bind('socket-unknown', {
      roomId: ROOM_ID,
      playerId: UNKNOWN_ID,
    });
    assert.throws(() => unknown.planner.prepare(ROOM_ID));

    const base = createLobbyConnectionRegistry();
    base.bind('socket-a', { roomId: ROOM_ID, playerId: HOST_ID });
    base.bind('socket-b', { roomId: ROOM_ID, playerId: SECOND_ID });
    const duplicateRegistry: LobbyConnectionRegistry = {
      ...base,
      listByRoomId: () => [
        { socketId: 'socket-a', roomId: ROOM_ID, playerId: HOST_ID },
        { socketId: 'socket-b', roomId: ROOM_ID, playerId: HOST_ID },
      ],
    };
    assert.throws(() =>
      createPlanner(room(), duplicateRegistry).planner.prepare(ROOM_ID),
    );
  });

  it('rejects malformed, missing, and mismatched projection results atomically', () => {
    const setup = createPlanner(room(), undefined, (currentRoom, viewer) => {
      if (viewer === SECOND_ID) throw new Error('projection detail');
      const snapshot = {
        version: 1,
        phase: 'lobby',
        roomId: currentRoom.roomId,
        roomCode: currentRoom.roomCode,
        revision: currentRoom.revision,
        selfPlayerId: viewer,
        hostPlayerId: currentRoom.hostPlayerId,
        settings: { ...currentRoom.settings },
        players: [],
        startEligibility: { eligible: false, blockers: [] },
        capabilities: {
          canChangeSettings: false,
          canManageSeats: false,
          canRemovePlayers: false,
          canStartMatch: false,
        },
      };
      return snapshot as never;
    });
    setup.registry.bind('socket-host', { roomId: ROOM_ID, playerId: HOST_ID });
    setup.registry.bind('socket-two', { roomId: ROOM_ID, playerId: SECOND_ID });
    assert.throws(() => setup.planner.prepare(ROOM_ID));
    assert.throws(() => setup.planner.prepare('invalid'));
    assert.throws(() => setup.planner.prepare(SECOND_ROOM_ID));
  });
});
