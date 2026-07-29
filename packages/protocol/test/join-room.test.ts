import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOBBY_JOIN_ROOM_EVENT,
  parseJoinRoomAcknowledgement,
  parseJoinRoomCommand,
  parseJoinRoomErrorAcknowledgement,
  parseJoinRoomSuccess,
} from '../src/index.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = '33333333-3333-4333-8333-333333333333';
const SELF_ID = '44444444-4444-4444-8444-444444444444';
const command = {
  commandId: COMMAND_ID,
  roomCode: 'ABC234',
  displayName: 'Blair',
};
const snapshot = {
  version: 1,
  phase: 'lobby',
  roomId: ROOM_ID,
  roomCode: 'ABC234',
  revision: 1,
  selfPlayerId: SELF_ID,
  hostPlayerId: HOST_ID,
  settings: { startingLevel: 2, turnTimer: 'off', hasPassword: false },
  players: [
    {
      playerId: HOST_ID,
      displayName: 'Alex',
      seat: null,
      ready: false,
      connectionStatus: 'connected',
      isHost: true,
      isSelf: false,
    },
    {
      playerId: SELF_ID,
      displayName: 'Blair',
      seat: null,
      ready: false,
      connectionStatus: 'connected',
      isHost: false,
      isSelf: true,
    },
  ],
  startEligibility: {
    eligible: false,
    blockers: [
      'NOT_FOUR_PLAYERS',
      'NOT_FOUR_SEATS_OCCUPIED',
      'NOT_ALL_PLAYERS_READY',
    ],
  },
  capabilities: {
    canChangeSettings: false,
    canManageSeats: false,
    canRemovePlayers: false,
    canStartMatch: false,
  },
};
const success = {
  status: 'ok',
  commandId: COMMAND_ID,
  roomRevision: 1,
  snapshot,
};

describe('join-room command', () => {
  it('exports the canonical event and parses a valid command', () => {
    assert.equal(LOBBY_JOIN_ROOM_EVENT, 'lobby:join-room');
    assert.deepEqual(parseJoinRoomCommand(command), command);
  });

  it('normalizes raw display-name input', () => {
    assert.deepEqual(
      parseJoinRoomCommand({ ...command, displayName: '  Ｂｌａｉｒ  ' }),
      command,
    );
  });

  for (const [name, value] of [
    ['lowercase code', { ...command, roomCode: 'abc234' }],
    ['padded code', { ...command, roomCode: ' ABC234 ' }],
    ['short code', { ...command, roomCode: 'ABC23' }],
    ['excluded-code character', { ...command, roomCode: 'ABC230' }],
    ['invalid name', { ...command, displayName: 'Blair\nSmith' }],
    ['invalid command ID', { ...command, commandId: 'invalid' }],
    ['missing field', { commandId: COMMAND_ID, roomCode: 'ABC234' }],
    ['additional field', { ...command, revision: 0 }],
    ['client room ID', { ...command, roomId: ROOM_ID }],
    ['client player ID', { ...command, playerId: SELF_ID }],
    ['client host ID', { ...command, hostPlayerId: HOST_ID }],
    ['client known revision', { ...command, knownRevision: 0 }],
    ['client seat', { ...command, seat: null }],
    ['client ready state', { ...command, ready: false }],
    ['client join order', { ...command, joinOrder: 1 }],
    ['client connection status', { ...command, connectionStatus: 'connected' }],
    ['client settings', { ...command, settings: {} }],
    ['client password', { ...command, password: 'secret' }],
    ['client password flag', { ...command, hasPassword: false }],
    ['client name key', { ...command, displayNameKey: 'blair' }],
    ['array', [command]],
    ['null', null],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseJoinRoomCommand(value), undefined);
    });
  }
});

describe('join-room acknowledgement', () => {
  it('accepts revisions one and later', () => {
    assert.deepEqual(parseJoinRoomSuccess(success), success);
    const later = {
      ...success,
      roomRevision: 3,
      snapshot: { ...snapshot, revision: 3 },
    };
    assert.deepEqual(parseJoinRoomSuccess(later), later);
    assert.deepEqual(parseJoinRoomAcknowledgement(later), later);
  });

  for (const [name, value] of [
    [
      'zero revision',
      { ...success, roomRevision: 0, snapshot: { ...snapshot, revision: 0 } },
    ],
    [
      'self equals host',
      { ...success, snapshot: { ...snapshot, selfPlayerId: HOST_ID } },
    ],
    [
      'self seated',
      {
        ...success,
        snapshot: {
          ...snapshot,
          players: snapshot.players.map((player) =>
            player.playerId === SELF_ID ? { ...player, seat: 0 } : player,
          ),
        },
      },
    ],
    [
      'self ready',
      {
        ...success,
        snapshot: {
          ...snapshot,
          players: snapshot.players.map((player) =>
            player.playerId === SELF_ID
              ? { ...player, seat: 0, ready: true }
              : player,
          ),
        },
      },
    ],
    [
      'self disconnected',
      {
        ...success,
        snapshot: {
          ...snapshot,
          players: snapshot.players.map((player) =>
            player.playerId === SELF_ID
              ? { ...player, connectionStatus: 'disconnected' }
              : player,
          ),
        },
      },
    ],
    [
      'host capability for self',
      {
        ...success,
        snapshot: {
          ...snapshot,
          capabilities: { ...snapshot.capabilities, canManageSeats: true },
        },
      },
    ],
    [
      'only one player',
      {
        ...success,
        snapshot: { ...snapshot, players: [snapshot.players[1]] },
      },
    ],
    [
      'five players',
      {
        ...success,
        snapshot: {
          ...snapshot,
          players: [
            ...snapshot.players,
            ...[5, 6, 7].map((suffix) => ({
              playerId: `${suffix}0000000-0000-4000-8000-00000000000${suffix}`,
              displayName: `Player ${suffix}`,
              seat: null,
              ready: false,
              connectionStatus: 'connected',
              isHost: false,
              isSelf: false,
            })),
          ],
        },
      },
    ],
    [
      'password room',
      {
        ...success,
        snapshot: {
          ...snapshot,
          settings: { ...snapshot.settings, hasPassword: true },
        },
      },
    ],
    ['extra key', { ...success, detail: true }],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseJoinRoomSuccess(value), undefined);
    });
  }

  for (const code of [
    'INVALID_PAYLOAD',
    'ROOM_NOT_FOUND',
    'COMMAND_ID_CONFLICT',
    'INVALID_LOBBY_STATE',
    'INTERNAL_ERROR',
    'ALREADY_IN_ROOM',
    'ROOM_FULL',
    'NAME_TAKEN',
  ] as const) {
    it(`accepts ${code}`, () => {
      const error = {
        status: 'error',
        code,
        message: 'Join failed',
        commandId: COMMAND_ID,
      };
      assert.deepEqual(parseJoinRoomErrorAcknowledgement(error), error);
    });
  }

  for (const value of [
    { status: 'error', code: 'PASSWORD_REQUIRED', message: 'No' },
    { status: 'error', code: 'INTERNAL_ERROR', message: '' },
    { status: 'error', code: 'INTERNAL_ERROR', message: 'a'.repeat(161) },
    { status: 'error', code: 'INTERNAL_ERROR', message: 'No', revision: 1 },
    {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'No',
      commandId: 'invalid',
    },
  ]) {
    it('rejects invalid errors', () => {
      assert.equal(parseJoinRoomErrorAcknowledgement(value), undefined);
    });
  }
});
