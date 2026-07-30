import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  LOBBY_SET_SEAT_EVENT,
  parseSetSeatAcknowledgement,
  parseSetSeatCommand,
  parseSetSeatErrorAcknowledgement,
  parseSetSeatSuccess,
  type ScaffoldClientToServerEvents,
  type SetSeatAcknowledgement,
} from '../src/index.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';

function snapshot(seat: 0 | 1 | 2 | 3 | null = null, revision = 3) {
  return {
    version: 1 as const,
    phase: 'lobby' as const,
    roomId: ROOM_ID,
    roomCode: 'ABC234',
    revision,
    selfPlayerId: PLAYER_ID,
    hostPlayerId: PLAYER_ID,
    settings: {
      startingLevel: 2 as const,
      turnTimer: 'off' as const,
      hasPassword: false,
    },
    players: [
      {
        playerId: PLAYER_ID,
        displayName: 'Alex',
        seat,
        ready: false,
        connectionStatus: 'connected' as const,
        isHost: true,
        isSelf: true,
      },
    ],
    startEligibility: {
      eligible: false,
      blockers: [
        'NOT_FOUR_PLAYERS' as const,
        'NOT_FOUR_SEATS_OCCUPIED' as const,
        'NOT_ALL_PLAYERS_READY' as const,
      ],
    },
    capabilities: {
      canChangeSettings: true,
      canManageSeats: true,
      canRemovePlayers: true,
      canStartMatch: false,
    },
  };
}

function success(seat: 0 | 1 | 2 | 3 | null = null, revision = 3) {
  return {
    status: 'ok' as const,
    commandId: COMMAND_ID,
    roomRevision: revision,
    snapshot: snapshot(seat, revision),
  };
}

describe('set-seat command', () => {
  it('exports the canonical event with command-specific typing', () => {
    assert.equal(LOBBY_SET_SEAT_EVENT, 'lobby:set-seat');
    const listener: ScaffoldClientToServerEvents[typeof LOBBY_SET_SEAT_EVENT] =
      (rawCommand, acknowledge) => {
        assert.deepEqual(rawCommand, {
          commandId: COMMAND_ID,
          knownRevision: 3,
          seat: 2,
        });
        acknowledge(success(2) as SetSeatAcknowledgement);
      };
    let acknowledged: SetSeatAcknowledgement | undefined;
    listener({ commandId: COMMAND_ID, knownRevision: 3, seat: 2 }, (value) => {
      acknowledged = value;
    });
    assert.deepEqual(acknowledged, success(2));
  });

  it('keeps the protocol package independent from Socket.IO', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    assert.equal(packageJson.dependencies?.['socket.io'], undefined);
    assert.equal(packageJson.dependencies?.['socket.io-client'], undefined);
    assert.equal(packageJson.devDependencies?.['socket.io'], undefined);
    assert.equal(packageJson.devDependencies?.['socket.io-client'], undefined);
  });

  for (const seat of [0, 1, 2, 3, null] as const) {
    it(`accepts seat ${String(seat)}`, () => {
      const command = { commandId: COMMAND_ID, knownRevision: 3, seat };
      assert.deepEqual(parseSetSeatCommand(command), command);
    });
  }

  for (const [name, value] of [
    ['missing seat', { commandId: COMMAND_ID, knownRevision: 3 }],
    [
      'additional field',
      { commandId: COMMAND_ID, knownRevision: 3, seat: 0, playerId: PLAYER_ID },
    ],
    ['invalid command ID', { commandId: 'invalid', knownRevision: 3, seat: 0 }],
    [
      'negative revision',
      { commandId: COMMAND_ID, knownRevision: -1, seat: 0 },
    ],
    [
      'fractional revision',
      { commandId: COMMAND_ID, knownRevision: 1.5, seat: 0 },
    ],
    [
      'unsafe revision',
      {
        commandId: COMMAND_ID,
        knownRevision: Number.MAX_SAFE_INTEGER + 1,
        seat: 0,
      },
    ],
    ['string revision', { commandId: COMMAND_ID, knownRevision: '3', seat: 0 }],
    ['string seat', { commandId: COMMAND_ID, knownRevision: 3, seat: '0' }],
    ['fractional seat', { commandId: COMMAND_ID, knownRevision: 3, seat: 1.5 }],
    ['negative seat', { commandId: COMMAND_ID, knownRevision: 3, seat: -1 }],
    ['high seat', { commandId: COMMAND_ID, knownRevision: 3, seat: 4 }],
    ['boolean seat', { commandId: COMMAND_ID, knownRevision: 3, seat: false }],
    [
      'client room ID',
      { commandId: COMMAND_ID, knownRevision: 3, seat: 0, roomId: ROOM_ID },
    ],
    [
      'client ready state',
      { commandId: COMMAND_ID, knownRevision: 3, seat: 0, ready: false },
    ],
    ['array', [{ commandId: COMMAND_ID, knownRevision: 3, seat: 0 }]],
    ['null command', null],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseSetSeatCommand(value), undefined);
    });
  }
});

describe('set-seat acknowledgement', () => {
  it('accepts an exact success for every requested seat representation', () => {
    for (const seat of [0, 1, 2, 3, null] as const) {
      const value = success(seat);
      assert.deepEqual(parseSetSeatSuccess(value), value);
      assert.deepEqual(parseSetSeatAcknowledgement(value), value);
    }
  });

  for (const [name, value] of [
    [
      'revision mismatch',
      { ...success(2), roomRevision: success(2).roomRevision + 1 },
    ],
    ['additional success field', { ...success(2), changed: true }],
    [
      'invalid snapshot phase',
      { ...success(2), snapshot: { ...snapshot(2), phase: 'match' } },
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseSetSeatSuccess(value), undefined);
    });
  }

  for (const code of [
    'INVALID_PAYLOAD',
    'NOT_ROOM_MEMBER',
    'COMMAND_ID_CONFLICT',
    'SEAT_TAKEN',
    'INVALID_LOBBY_STATE',
    'INTERNAL_ERROR',
  ] as const) {
    it(`accepts ${code} without current revision`, () => {
      const value = {
        status: 'error' as const,
        code,
        message: 'Seat selection failed',
        commandId: COMMAND_ID,
      };
      assert.deepEqual(parseSetSeatErrorAcknowledgement(value), value);
      assert.deepEqual(parseSetSeatAcknowledgement(value), value);
    });
  }

  it('requires current revision for STALE_REVISION', () => {
    const value = {
      status: 'error' as const,
      code: 'STALE_REVISION' as const,
      message: 'Room revision is stale',
      commandId: COMMAND_ID,
      currentRevision: 4,
    };
    assert.deepEqual(parseSetSeatErrorAcknowledgement(value), value);
  });

  for (const [name, value] of [
    [
      'unknown code',
      { status: 'error', code: 'ROOM_NOT_FOUND', message: 'No' },
    ],
    [
      'stale without revision',
      { status: 'error', code: 'STALE_REVISION', message: 'Stale' },
    ],
    [
      'revision on non-stale error',
      {
        status: 'error',
        code: 'SEAT_TAKEN',
        message: 'Taken',
        currentRevision: 3,
      },
    ],
    [
      'invalid command ID',
      {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Failed',
        commandId: 'invalid',
      },
    ],
    ['empty message', { status: 'error', code: 'INTERNAL_ERROR', message: '' }],
    [
      'oversized message',
      { status: 'error', code: 'INTERNAL_ERROR', message: 'a'.repeat(161) },
    ],
    [
      'additional field',
      {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Failed',
        detail: true,
      },
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseSetSeatErrorAcknowledgement(value), undefined);
    });
  }
});
