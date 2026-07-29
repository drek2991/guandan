import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOBBY_CREATE_ROOM_EVENT,
  parseCreateRoomAcknowledgement,
  parseCreateRoomCommand,
  parseCreateRoomErrorAcknowledgement,
  parseCreateRoomSuccess,
} from '../src/index.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';
const PLAYER_ID = '33333333-3333-4333-8333-333333333333';
const validCommand = {
  commandId: COMMAND_ID,
  displayName: 'Alex',
  settings: { startingLevel: 2, turnTimer: 'off' },
};
const validSnapshot = {
  version: 1,
  phase: 'lobby',
  roomId: ROOM_ID,
  roomCode: 'ABC234',
  revision: 0,
  selfPlayerId: PLAYER_ID,
  hostPlayerId: PLAYER_ID,
  settings: { startingLevel: 2, turnTimer: 'off', hasPassword: false },
  players: [
    {
      playerId: PLAYER_ID,
      displayName: 'Alex',
      seat: null,
      ready: false,
      connectionStatus: 'connected',
      isHost: true,
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
    canChangeSettings: true,
    canManageSeats: true,
    canRemovePlayers: true,
    canStartMatch: false,
  },
};
const validSuccess = {
  status: 'ok',
  commandId: COMMAND_ID,
  roomRevision: 0,
  snapshot: validSnapshot,
};

describe('create-room command', () => {
  it('exports one canonical event and accepts a valid command', () => {
    assert.equal(LOBBY_CREATE_ROOM_EVENT, 'lobby:create-room');
    assert.deepEqual(parseCreateRoomCommand(validCommand), validCommand);
  });

  it('canonicalizes raw display-name input', () => {
    assert.deepEqual(
      parseCreateRoomCommand({
        ...validCommand,
        displayName: '  Ａｌｅｘ  Smith  ',
      }),
      { ...validCommand, displayName: 'Alex Smith' },
    );
  });

  for (const [name, command] of [
    ['invalid display name', { ...validCommand, displayName: 'Alex\nSmith' }],
    [
      'invalid starting level',
      {
        ...validCommand,
        settings: { ...validCommand.settings, startingLevel: 3 },
      },
    ],
    [
      'invalid timer',
      {
        ...validCommand,
        settings: { ...validCommand.settings, turnTimer: 45 },
      },
    ],
    ['missing field', { commandId: COMMAND_ID, displayName: 'Alex' }],
    ['additional field', { ...validCommand, roomCode: 'ABC234' }],
    ['client room ID', { ...validCommand, roomId: ROOM_ID }],
    ['client player ID', { ...validCommand, playerId: PLAYER_ID }],
    ['client revision', { ...validCommand, revision: 0 }],
    [
      'password presence',
      {
        ...validCommand,
        settings: { ...validCommand.settings, hasPassword: false },
      },
    ],
    ['array payload', [validCommand]],
    ['null payload', null],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseCreateRoomCommand(command), undefined);
    });
  }
});

describe('create-room acknowledgements', () => {
  it('accepts the exact initial success acknowledgement', () => {
    assert.deepEqual(parseCreateRoomSuccess(validSuccess), validSuccess);
    assert.deepEqual(
      parseCreateRoomAcknowledgement(validSuccess),
      validSuccess,
    );
  });

  for (const [name, success] of [
    ['nonzero initial revision', { ...validSuccess, roomRevision: 1 }],
    [
      'snapshot revision mismatch',
      {
        ...validSuccess,
        roomRevision: 1,
        snapshot: { ...validSnapshot, revision: 0 },
      },
    ],
    [
      'creator not host',
      {
        ...validSuccess,
        snapshot: { ...validSnapshot, hostPlayerId: ROOM_ID },
      },
    ],
    [
      'password-protected snapshot',
      {
        ...validSuccess,
        snapshot: {
          ...validSnapshot,
          settings: { ...validSnapshot.settings, hasPassword: true },
        },
      },
    ],
    ['extra success key', { ...validSuccess, room: {} }],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseCreateRoomSuccess(success), undefined);
    });
  }

  for (const code of [
    'INVALID_PAYLOAD',
    'COMMAND_ID_CONFLICT',
    'INVALID_LOBBY_STATE',
    'INTERNAL_ERROR',
    'ALREADY_IN_ROOM',
    'ROOM_CODE_UNAVAILABLE',
  ] as const) {
    it(`accepts ${code}`, () => {
      const error = {
        status: 'error',
        code,
        message: 'Create-room failed',
        commandId: COMMAND_ID,
      };
      assert.deepEqual(parseCreateRoomErrorAcknowledgement(error), error);
      assert.deepEqual(parseCreateRoomAcknowledgement(error), error);
    });
  }

  for (const [name, error] of [
    [
      'unknown error code',
      { status: 'error', code: 'ROOM_FULL', message: 'Room full' },
    ],
    [
      'oversized error message',
      { status: 'error', code: 'INTERNAL_ERROR', message: 'a'.repeat(161) },
    ],
    [
      'extra error key',
      {
        status: 'error',
        code: 'INTERNAL_ERROR',
        message: 'Failed',
        detail: true,
      },
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseCreateRoomErrorAcknowledgement(error), undefined);
    });
  }
});
