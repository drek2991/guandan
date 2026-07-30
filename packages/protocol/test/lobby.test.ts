import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  INITIAL_LOBBY_REVISION,
  LOBBY_SNAPSHOT_EVENT,
  deriveDisplayNameKey,
  getPartnerSeat,
  normalizeDisplayName,
  parseCommandId,
  parseDisplayName,
  parseLobbyAcknowledgement,
  parseLobbyErrorAcknowledgement,
  parseLobbyMutationMetadata,
  parseLobbyMutationSuccess,
  parseLobbySnapshotV1,
  parsePlayerId,
  parseRoomCode,
  parseRoomId,
  parseRoomRevision,
  parseSeatIndex,
  parseStartingLevel,
  parseTurnTimer,
  type LobbySnapshotV1,
  type ScaffoldServerToClientEvents,
} from '../src/index.js';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_TWO_ID = '33333333-3333-4333-8333-333333333333';
const PLAYER_THREE_ID = '44444444-4444-4444-8444-444444444444';
const PLAYER_FOUR_ID = '55555555-5555-4555-8555-555555555555';
const COMMAND_ID = '66666666-6666-4666-8666-666666666666';

const validPlayers = [
  {
    playerId: HOST_ID,
    displayName: 'Alex',
    seat: 0,
    ready: true,
    connectionStatus: 'connected',
    isHost: true,
    isSelf: true,
  },
  {
    playerId: PLAYER_TWO_ID,
    displayName: 'Blair',
    seat: 1,
    ready: true,
    connectionStatus: 'connected',
    isHost: false,
    isSelf: false,
  },
  {
    playerId: PLAYER_THREE_ID,
    displayName: 'Casey',
    seat: 2,
    ready: true,
    connectionStatus: 'disconnected',
    isHost: false,
    isSelf: false,
  },
  {
    playerId: PLAYER_FOUR_ID,
    displayName: 'Devon',
    seat: 3,
    ready: true,
    connectionStatus: 'connected',
    isHost: false,
    isSelf: false,
  },
] as const;

const validSnapshot = {
  version: 1,
  phase: 'lobby',
  roomId: ROOM_ID,
  roomCode: 'ABC234',
  revision: 7,
  selfPlayerId: HOST_ID,
  hostPlayerId: HOST_ID,
  settings: {
    startingLevel: 2,
    turnTimer: 30,
    hasPassword: true,
  },
  players: validPlayers,
  startEligibility: {
    eligible: true,
    blockers: [],
  },
  capabilities: {
    canChangeSettings: true,
    canManageSeats: true,
    canRemovePlayers: true,
    canStartMatch: true,
  },
};

describe('lobby identifiers, revisions, seats, and settings', () => {
  it('accepts canonical lowercase UUID v4 identifiers', () => {
    assert.equal(parseRoomId(ROOM_ID), ROOM_ID);
    assert.equal(parsePlayerId(HOST_ID), HOST_ID);
    assert.equal(parseCommandId(COMMAND_ID), COMMAND_ID);
  });

  for (const invalid of [
    '11111111-1111-1111-8111-111111111111',
    '11111111-1111-4111-7111-111111111111',
    '11111111-1111-4111-8111-11111111111A',
    'not-a-uuid',
    null,
  ]) {
    it(`rejects malformed identifier ${String(invalid)}`, () => {
      assert.equal(parseRoomId(invalid), undefined);
    });
  }

  it('exports zero as the initial revision and accepts later revisions', () => {
    assert.equal(INITIAL_LOBBY_REVISION, 0);
    assert.equal(parseRoomRevision(0), 0);
    assert.equal(parseRoomRevision(42), 42);
  });

  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0']) {
    it(`rejects invalid revision ${String(invalid)}`, () => {
      assert.equal(parseRoomRevision(invalid), undefined);
    });
  }

  it('accepts exactly four seats and maps opposite partners', () => {
    for (const seat of [0, 1, 2, 3] as const) {
      assert.equal(parseSeatIndex(seat), seat);
    }
    assert.equal(getPartnerSeat(0), 2);
    assert.equal(getPartnerSeat(2), 0);
    assert.equal(getPartnerSeat(1), 3);
    assert.equal(getPartnerSeat(3), 1);
    assert.equal(parseSeatIndex(4), undefined);
  });

  it('accepts only approved starting levels and timers', () => {
    assert.equal(parseStartingLevel(2), 2);
    assert.equal(parseStartingLevel(7), 7);
    assert.equal(parseStartingLevel(3), undefined);
    assert.equal(parseTurnTimer('off'), 'off');
    assert.equal(parseTurnTimer(30), 30);
    assert.equal(parseTurnTimer(60), 60);
    assert.equal(parseTurnTimer(45), undefined);
  });
});

describe('room-code parsing', () => {
  it('accepts a valid six-character code', () => {
    assert.equal(parseRoomCode('ABC234'), 'ABC234');
  });

  for (const [name, value] of [
    ['lowercase code', 'abc234'],
    ['short code', 'ABC23'],
    ['long code', 'ABC2345'],
    ['ambiguous I', 'ABI234'],
    ['ambiguous O', 'ABO234'],
    ['ambiguous zero', 'ABC230'],
    ['ambiguous one', 'ABC231'],
    ['symbol', 'ABC2-4'],
    ['whitespace', 'ABC 34'],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseRoomCode(value), undefined);
    });
  }
});

describe('display-name normalization', () => {
  it('accepts a valid simple canonical name', () => {
    assert.equal(normalizeDisplayName('Alex'), 'Alex');
    assert.equal(parseDisplayName('Alex'), 'Alex');
  });

  it('normalizes surrounding and internal non-control whitespace', () => {
    assert.equal(normalizeDisplayName('  Alex   Rivera  '), 'Alex Rivera');
    assert.equal(parseDisplayName('  Alex  '), undefined);
  });

  it('uses NFKC and a case-insensitive uniqueness key', () => {
    assert.equal(normalizeDisplayName('Ａｌｅｘ'), 'Alex');
    for (const name of ['Alex', 'alex', 'Ａｌｅｘ', ' Alex ']) {
      assert.equal(deriveDisplayNameKey(name), 'alex');
    }
  });

  it('counts Unicode code points rather than UTF-16 units', () => {
    assert.equal(normalizeDisplayName('😀'.repeat(24)), '😀'.repeat(24));
    assert.equal(normalizeDisplayName('😀'.repeat(25)), undefined);
  });

  it('retains Unicode format characters used by emoji sequences', () => {
    assert.equal(normalizeDisplayName('👩‍💻'), '👩‍💻');
  });

  for (const [name, value] of [
    ['empty name', '   '],
    ['more than 24 code points', 'a'.repeat(25)],
    ['control character', 'Alex'],
    ['line feed', 'Alex\nRivera'],
    ['carriage return', 'Alex\rRivera'],
    ['line separator', `Alex${String.fromCodePoint(0x2028)}Rivera`],
    ['paragraph separator', `Alex${String.fromCodePoint(0x2029)}Rivera`],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(normalizeDisplayName(value), undefined);
    });
  }
});

describe('LobbySnapshotV1 parsing', () => {
  it('exports the canonical snapshot event with one typed payload', () => {
    assert.equal(LOBBY_SNAPSHOT_EVENT, 'lobby:snapshot');
    const listener: ScaffoldServerToClientEvents[typeof LOBBY_SNAPSHOT_EVENT] =
      (snapshot) => {
        assert.equal(snapshot.roomId, ROOM_ID);
      };
    listener(parseLobbySnapshotV1(validSnapshot) as LobbySnapshotV1);
  });

  it('keeps the protocol package independent from Socket.IO', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    assert.equal(packageJson.dependencies?.['socket.io'], undefined);
    assert.equal(packageJson.dependencies?.['socket.io-client'], undefined);
  });

  it('accepts a valid strict snapshot', () => {
    assert.deepEqual(parseLobbySnapshotV1(validSnapshot), validSnapshot);
  });

  it('accepts a blocked non-host snapshot with derived capabilities', () => {
    const snapshot = {
      ...validSnapshot,
      selfPlayerId: PLAYER_TWO_ID,
      players: validSnapshot.players.map((player) => ({
        ...player,
        ready: player.playerId !== PLAYER_FOUR_ID,
        isSelf: player.playerId === PLAYER_TWO_ID,
      })),
      startEligibility: {
        eligible: false,
        blockers: ['NOT_ALL_PLAYERS_READY'],
      },
      capabilities: {
        canChangeSettings: false,
        canManageSeats: false,
        canRemovePlayers: false,
        canStartMatch: false,
      },
    };
    assert.deepEqual(parseLobbySnapshotV1(snapshot), snapshot);
  });

  for (const [name, snapshot] of [
    ['invalid version', { ...validSnapshot, version: 2 }],
    ['missing key', omit(validSnapshot, 'roomCode')],
    ['extra key', { ...validSnapshot, internal: true }],
    ['invalid room ID', { ...validSnapshot, roomId: 'invalid' }],
    [
      'duplicate player ID',
      {
        ...validSnapshot,
        players: validSnapshot.players.map((player, index) =>
          index === 1 ? { ...player, playerId: HOST_ID } : player,
        ),
      },
    ],
    [
      'duplicate derived display name',
      {
        ...validSnapshot,
        players: validSnapshot.players.map((player, index) =>
          index === 1 ? { ...player, displayName: 'alex' } : player,
        ),
      },
    ],
    [
      'duplicate occupied seat',
      {
        ...validSnapshot,
        players: validSnapshot.players.map((player, index) =>
          index === 1 ? { ...player, seat: 0 } : player,
        ),
      },
    ],
    ['missing self player', { ...validSnapshot, selfPlayerId: COMMAND_ID }],
    ['missing host player', { ...validSnapshot, hostPlayerId: COMMAND_ID }],
    [
      'contradictory isSelf',
      {
        ...validSnapshot,
        players: validSnapshot.players.map((player, index) =>
          index === 1 ? { ...player, isSelf: true } : player,
        ),
      },
    ],
    [
      'contradictory isHost',
      {
        ...validSnapshot,
        players: validSnapshot.players.map((player, index) =>
          index === 1 ? { ...player, isHost: true } : player,
        ),
      },
    ],
    [
      'wrong blocker order',
      {
        ...validSnapshot,
        players: validSnapshot.players.slice(0, 1),
        startEligibility: {
          eligible: false,
          blockers: [
            'NOT_ALL_PLAYERS_READY',
            'NOT_FOUR_PLAYERS',
            'NOT_FOUR_SEATS_OCCUPIED',
          ],
        },
        capabilities: {
          ...validSnapshot.capabilities,
          canStartMatch: false,
        },
      },
    ],
    [
      'capabilities inconsistent with host viewer',
      {
        ...validSnapshot,
        capabilities: {
          ...validSnapshot.capabilities,
          canManageSeats: false,
        },
      },
    ],
    ['malformed player array', { ...validSnapshot, players: null }],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseLobbySnapshotV1(snapshot), undefined);
    });
  }
});

describe('lobby mutation and acknowledgement foundations', () => {
  it('accepts exact existing-room metadata', () => {
    const metadata = { commandId: COMMAND_ID, knownRevision: 7 };
    assert.deepEqual(parseLobbyMutationMetadata(metadata), metadata);
  });

  for (const metadata of [
    { commandId: 'invalid', knownRevision: 7 },
    { commandId: COMMAND_ID, knownRevision: -1 },
    { commandId: COMMAND_ID, knownRevision: 7, extra: true },
    null,
    [],
  ]) {
    it('rejects malformed existing-room metadata', () => {
      assert.equal(parseLobbyMutationMetadata(metadata), undefined);
    });
  }

  it('accepts a success whose revision matches the snapshot', () => {
    const success = {
      status: 'ok',
      commandId: COMMAND_ID,
      roomRevision: 7,
      snapshot: validSnapshot,
    };
    assert.deepEqual(parseLobbyMutationSuccess(success), success);
    assert.deepEqual(parseLobbyAcknowledgement(success), success);
  });

  it('rejects a success whose revision differs from the snapshot', () => {
    assert.equal(
      parseLobbyMutationSuccess({
        status: 'ok',
        commandId: COMMAND_ID,
        roomRevision: 8,
        snapshot: validSnapshot,
      }),
      undefined,
    );
  });

  it('accepts exact error acknowledgements with optional context', () => {
    const error = {
      status: 'error',
      code: 'STALE_REVISION',
      message: 'The room revision has changed',
      commandId: COMMAND_ID,
      currentRevision: 8,
    };
    assert.deepEqual(parseLobbyErrorAcknowledgement(error), error);
    assert.deepEqual(parseLobbyAcknowledgement(error), error);
    assert.deepEqual(
      parseLobbyErrorAcknowledgement({
        status: 'error',
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found',
      }),
      { status: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' },
    );
  });

  for (const [name, error] of [
    [
      'unknown error code',
      { status: 'error', code: 'NAME_TAKEN', message: 'Name taken' },
    ],
    [
      'oversized error message',
      { status: 'error', code: 'INTERNAL_ERROR', message: 'a'.repeat(161) },
    ],
    [
      'invalid optional command ID',
      {
        status: 'error',
        code: 'INVALID_PAYLOAD',
        message: 'Invalid',
        commandId: 'invalid',
      },
    ],
    [
      'invalid optional revision',
      {
        status: 'error',
        code: 'STALE_REVISION',
        message: 'Stale',
        currentRevision: -1,
      },
    ],
    [
      'extra error field',
      {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Failed',
        detail: 'secret',
      },
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseLobbyErrorAcknowledgement(error), undefined);
    });
  }
});

function omit<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const { [key]: _omitted, ...rest } = value;
  return rest;
}
