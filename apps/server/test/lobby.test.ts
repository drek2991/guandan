import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveDisplayNameKey,
  parseLobbySnapshotV1,
  type PlayerId,
} from '@guandan/protocol';

import {
  assertValidLobbyRoomState,
  LobbyInvariantError,
} from '../src/lobby/invariants.js';
import type { LobbyPlayerState, LobbyRoomState } from '../src/lobby/model.js';
import { projectLobbySnapshot } from '../src/lobby/snapshot.js';
import { deriveLobbyStartEligibility } from '../src/lobby/start-eligibility.js';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_TWO_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_THREE_ID = '44444444-4444-4444-8444-444444444444';
const PLAYER_FOUR_ID = '55555555-5555-4555-8555-555555555555';
const OUTSIDER_ID = '66666666-6666-4666-8666-666666666666';

function createPlayer(
  playerId: PlayerId,
  displayName: string,
  joinOrder: number,
  overrides: Partial<LobbyPlayerState> = {},
): LobbyPlayerState {
  const normalizedKey = deriveDisplayNameKey(displayName);
  assert.notEqual(normalizedKey, undefined);
  return {
    playerId,
    displayName,
    displayNameKey: normalizedKey as string,
    joinOrder,
    seat: null,
    ready: false,
    connectionStatus: 'connected',
    ...overrides,
  };
}

function createOnePlayerRoom(
  overrides: Partial<LobbyRoomState> = {},
): LobbyRoomState {
  return {
    roomId: ROOM_ID,
    roomCode: 'ABC234',
    revision: 0,
    phase: 'lobby',
    hostPlayerId: HOST_ID,
    settings: {
      startingLevel: 2,
      turnTimer: 'off',
      hasPassword: false,
    },
    players: [createPlayer(HOST_ID, 'Alex', 0)],
    ...overrides,
  };
}

function createFourPlayerRoom(
  playerOverrides: readonly Partial<LobbyPlayerState>[] = [],
): LobbyRoomState {
  return createOnePlayerRoom({
    revision: 7,
    settings: {
      startingLevel: 7,
      turnTimer: 60,
      hasPassword: true,
    },
    players: [
      createPlayer(HOST_ID, 'Alex', 0, {
        seat: 0,
        ready: true,
        ...playerOverrides[0],
      }),
      createPlayer(PLAYER_TWO_ID, 'Blair', 1, {
        seat: 1,
        ready: true,
        ...playerOverrides[1],
      }),
      createPlayer(PLAYER_THREE_ID, 'Casey', 2, {
        seat: 2,
        ready: true,
        ...playerOverrides[2],
      }),
      createPlayer(PLAYER_FOUR_ID, 'Devon', 3, {
        seat: 3,
        ready: true,
        ...playerOverrides[3],
      }),
    ],
  });
}

describe('authoritative lobby invariants', () => {
  it('accepts a valid one-player host lobby', () => {
    assert.doesNotThrow(() => assertValidLobbyRoomState(createOnePlayerRoom()));
  });

  it('accepts a valid four-player lobby', () => {
    assert.doesNotThrow(() =>
      assertValidLobbyRoomState(createFourPlayerRoom()),
    );
  });

  it('allows a disconnected seated and ready player', () => {
    const room = createFourPlayerRoom([{ connectionStatus: 'disconnected' }]);
    assert.doesNotThrow(() => assertValidLobbyRoomState(room));
  });

  for (const [name, createInvalidRoom, message] of [
    [
      'empty player list',
      () => createOnePlayerRoom({ players: [] }),
      /between one and four players/,
    ],
    [
      'host not in room',
      () => createOnePlayerRoom({ hostPlayerId: OUTSIDER_ID }),
      /host must be a room member/,
    ],
    [
      'invalid host identifier',
      () => createOnePlayerRoom({ hostPlayerId: 'invalid' }),
      /host player ID/,
    ],
    [
      'duplicate player ID',
      () => {
        const room = createFourPlayerRoom();
        room.players[1] = { ...room.players[1]!, playerId: HOST_ID };
        return room;
      },
      /player IDs must be unique/,
    ],
    [
      'duplicate display-name key',
      () => {
        const room = createFourPlayerRoom();
        room.players[1] = {
          ...room.players[1]!,
          displayName: 'alex',
          displayNameKey: 'alex',
        };
        return room;
      },
      /display names must be unique/,
    ],
    [
      'invalid stored display-name key',
      () => {
        const room = createOnePlayerRoom();
        room.players[0] = { ...room.players[0]!, displayNameKey: 'wrong' };
        return room;
      },
      /key must match/,
    ],
    [
      'duplicate join order',
      () => createFourPlayerRoom([{}, { joinOrder: 0 }]),
      /join orders must be unique/,
    ],
    [
      'duplicate seat',
      () => createFourPlayerRoom([{}, { seat: 0 }]),
      /occupied seats must be unique/,
    ],
    [
      'more than four players',
      () => {
        const room = createFourPlayerRoom();
        room.players.push(createPlayer(OUTSIDER_ID, 'Emery', 4));
        return room;
      },
      /between one and four players/,
    ],
    [
      'ready but unseated player',
      () =>
        createOnePlayerRoom({
          players: [createPlayer(HOST_ID, 'Alex', 0, { ready: true })],
        }),
      /ready lobby player must be seated/,
    ],
    [
      'invalid room ID',
      () => createOnePlayerRoom({ roomId: 'invalid' }),
      /room ID/,
    ],
    [
      'invalid room code',
      () => createOnePlayerRoom({ roomCode: 'abc234' }),
      /room code/,
    ],
    [
      'invalid revision',
      () => createOnePlayerRoom({ revision: -1 }),
      /revision/,
    ],
    [
      'invalid phase',
      () => ({ ...createOnePlayerRoom(), phase: 'match' }),
      /phase must be lobby/,
    ],
    [
      'secret field in settings',
      () => {
        const room = createOnePlayerRoom();
        return {
          ...room,
          settings: { ...room.settings, passwordHash: 'not-allowed' },
        };
      },
      /settings must contain exactly/,
    ],
    [
      'socket identifier in player',
      () => {
        const room = createOnePlayerRoom();
        return {
          ...room,
          players: [{ ...room.players[0]!, socketId: 'not-allowed' }],
        };
      },
      /player must contain exactly/,
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => assertValidLobbyRoomState(createInvalidRoom()),
        message,
      );
    });
  }

  it('fails with the dedicated deterministic invariant error', () => {
    assert.throws(
      () => assertValidLobbyRoomState(createOnePlayerRoom({ revision: -1 })),
      LobbyInvariantError,
    );
  });
});

describe('lobby start eligibility', () => {
  it('returns all blockers for one unseated and unready player', () => {
    assert.deepEqual(deriveLobbyStartEligibility(createOnePlayerRoom()), {
      eligible: false,
      blockers: [
        'NOT_FOUR_PLAYERS',
        'NOT_FOUR_SEATS_OCCUPIED',
        'NOT_ALL_PLAYERS_READY',
      ],
    });
  });

  it('returns seat and readiness blockers when a player is unseated', () => {
    const room = createFourPlayerRoom([
      {},
      {},
      {},
      { seat: null, ready: false },
    ]);
    assert.deepEqual(deriveLobbyStartEligibility(room), {
      eligible: false,
      blockers: ['NOT_FOUR_SEATS_OCCUPIED', 'NOT_ALL_PLAYERS_READY'],
    });
  });

  it('returns only the readiness blocker for four occupied seats', () => {
    const room = createFourPlayerRoom([{}, {}, {}, { ready: false }]);
    assert.deepEqual(deriveLobbyStartEligibility(room), {
      eligible: false,
      blockers: ['NOT_ALL_PLAYERS_READY'],
    });
  });

  it('is fully eligible with four seated ready players', () => {
    assert.deepEqual(deriveLobbyStartEligibility(createFourPlayerRoom()), {
      eligible: true,
      blockers: [],
    });
  });

  it('does not add a blocker for a disconnected seated ready player', () => {
    const room = createFourPlayerRoom([
      {},
      {},
      { connectionStatus: 'disconnected' },
    ]);
    assert.deepEqual(deriveLobbyStartEligibility(room), {
      eligible: true,
      blockers: [],
    });
  });
});

describe('player-specific lobby snapshot projection', () => {
  it('derives eligible host capabilities and public fields', () => {
    const snapshot = projectLobbySnapshot(createFourPlayerRoom(), HOST_ID);
    assert.deepEqual(snapshot.capabilities, {
      canChangeSettings: true,
      canManageSeats: true,
      canRemovePlayers: true,
      canStartMatch: true,
    });
    assert.equal(snapshot.selfPlayerId, HOST_ID);
    assert.equal(snapshot.hostPlayerId, HOST_ID);
    assert.equal(snapshot.players[0]?.isSelf, true);
    assert.equal(snapshot.players[0]?.isHost, true);
    assert.deepEqual(snapshot.settings, {
      startingLevel: 7,
      turnTimer: 60,
      hasPassword: true,
    });
    assert.deepEqual(parseLobbySnapshotV1(snapshot), snapshot);
  });

  it('prevents the host from starting while structurally blocked', () => {
    const snapshot = projectLobbySnapshot(createOnePlayerRoom(), HOST_ID);
    assert.equal(snapshot.capabilities.canStartMatch, false);
  });

  it('derives all non-host capabilities as false', () => {
    const snapshot = projectLobbySnapshot(
      createFourPlayerRoom(),
      PLAYER_TWO_ID,
    );
    assert.deepEqual(snapshot.capabilities, {
      canChangeSettings: false,
      canManageSeats: false,
      canRemovePlayers: false,
      canStartMatch: false,
    });
    assert.equal(
      snapshot.players.find((player) => player.playerId === PLAYER_TWO_ID)
        ?.isSelf,
      true,
    );
    assert.equal(
      snapshot.players.find((player) => player.playerId === HOST_ID)?.isHost,
      true,
    );
  });

  it('rejects a viewer who is not a room member', () => {
    assert.throws(
      () => projectLobbySnapshot(createOnePlayerRoom(), OUTSIDER_ID),
      /viewer must be a room member/,
    );
  });

  it('orders seated players by seat and unseated players by join order', () => {
    const room = createOnePlayerRoom({
      hostPlayerId: HOST_ID,
      players: [
        createPlayer(PLAYER_FOUR_ID, 'Devon', 3),
        createPlayer(PLAYER_TWO_ID, 'Blair', 1, { seat: 3 }),
        createPlayer(HOST_ID, 'Alex', 0),
        createPlayer(PLAYER_THREE_ID, 'Casey', 2, { seat: 1 }),
      ],
    });
    const snapshot = projectLobbySnapshot(room, HOST_ID);
    assert.deepEqual(
      snapshot.players.map((player) => player.playerId),
      [PLAYER_THREE_ID, PLAYER_TWO_ID, HOST_ID, PLAYER_FOUR_ID],
    );
  });

  it('excludes every internal-only player field', () => {
    const snapshot = projectLobbySnapshot(createOnePlayerRoom(), HOST_ID);
    const player = snapshot.players[0];
    assert.notEqual(player, undefined);
    assert.equal(Object.hasOwn(player as object, 'displayNameKey'), false);
    assert.equal(Object.hasOwn(player as object, 'joinOrder'), false);
    assert.equal(Object.hasOwn(player as object, 'socketId'), false);
    assert.equal(Object.hasOwn(snapshot.settings, 'password'), false);
    assert.equal(Object.hasOwn(snapshot.settings, 'passwordHash'), false);
  });
});
