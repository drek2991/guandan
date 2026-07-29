import {
  deriveDisplayNameKey,
  parseDisplayName,
  parsePlayerId,
  parseRoomCode,
  parseRoomId,
  parseRoomRevision,
  parseSeatIndex,
  parseStartingLevel,
  parseTurnTimer,
} from '@guandan/protocol';

import type { LobbyPlayerState, LobbyRoomState } from './model.js';

const ROOM_KEYS = new Set([
  'roomId',
  'roomCode',
  'revision',
  'phase',
  'hostPlayerId',
  'settings',
  'players',
]);
const SETTINGS_KEYS = new Set(['startingLevel', 'turnTimer', 'hasPassword']);
const PLAYER_KEYS = new Set([
  'playerId',
  'displayName',
  'displayNameKey',
  'joinOrder',
  'seat',
  'ready',
  'connectionStatus',
]);

export class LobbyInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LobbyInvariantError';
  }
}

export function assertValidLobbyRoomState(
  value: unknown,
): asserts value is LobbyRoomState {
  if (!isExactRecord(value, ROOM_KEYS)) {
    fail('Lobby room must contain exactly the authoritative fields');
  }
  if (value.phase !== 'lobby') {
    fail('Lobby phase must be lobby');
  }
  if (parseRoomId(value.roomId) === undefined) {
    fail('Lobby room ID must be a canonical UUID v4');
  }
  if (parseRoomCode(value.roomCode) === undefined) {
    fail('Lobby room code is invalid');
  }
  if (parseRoomRevision(value.revision) === undefined) {
    fail('Lobby revision must be a nonnegative safe integer');
  }
  const hostPlayerId = parsePlayerId(value.hostPlayerId);
  if (hostPlayerId === undefined) {
    fail('Lobby host player ID must be a canonical UUID v4');
  }
  assertValidSettings(value.settings);
  if (
    !Array.isArray(value.players) ||
    value.players.length < 1 ||
    value.players.length > 4
  ) {
    fail('Lobby must contain between one and four players');
  }

  const playerIds = new Set<string>();
  const displayNameKeys = new Set<string>();
  const joinOrders = new Set<number>();
  const occupiedSeats = new Set<number>();

  for (const player of value.players) {
    assertValidPlayer(player);

    if (playerIds.has(player.playerId)) {
      fail('Lobby player IDs must be unique');
    }
    if (displayNameKeys.has(player.displayNameKey)) {
      fail('Lobby display names must be unique');
    }
    if (joinOrders.has(player.joinOrder)) {
      fail('Lobby join orders must be unique');
    }
    if (player.seat !== null && occupiedSeats.has(player.seat)) {
      fail('Lobby occupied seats must be unique');
    }

    playerIds.add(player.playerId);
    displayNameKeys.add(player.displayNameKey);
    joinOrders.add(player.joinOrder);
    if (player.seat !== null) {
      occupiedSeats.add(player.seat);
    }
  }

  if (!playerIds.has(hostPlayerId)) {
    fail('Lobby host must be a room member');
  }
}

function assertValidSettings(value: unknown): void {
  if (!isExactRecord(value, SETTINGS_KEYS)) {
    fail('Lobby settings must contain exactly the public settings fields');
  }
  if (
    parseStartingLevel(value.startingLevel) === undefined ||
    parseTurnTimer(value.turnTimer) === undefined ||
    typeof value.hasPassword !== 'boolean'
  ) {
    fail('Lobby settings are invalid');
  }
}

function assertValidPlayer(value: unknown): asserts value is LobbyPlayerState {
  if (!isExactRecord(value, PLAYER_KEYS)) {
    fail('Lobby player must contain exactly the authoritative fields');
  }

  const displayName = parseDisplayName(value.displayName);
  const expectedDisplayNameKey =
    displayName === undefined ? undefined : deriveDisplayNameKey(displayName);
  const seat = value.seat === null ? null : parseSeatIndex(value.seat);

  if (parsePlayerId(value.playerId) === undefined) {
    fail('Lobby player ID must be a canonical UUID v4');
  }
  if (displayName === undefined) {
    fail('Lobby display name must be normalized and valid');
  }
  if (
    typeof value.displayNameKey !== 'string' ||
    value.displayNameKey !== expectedDisplayNameKey
  ) {
    fail('Lobby display-name key must match the normalized display name');
  }
  if (
    typeof value.joinOrder !== 'number' ||
    !Number.isSafeInteger(value.joinOrder) ||
    value.joinOrder < 0
  ) {
    fail('Lobby join order must be a nonnegative safe integer');
  }
  if (seat === undefined) {
    fail('Lobby seat must be null or a valid seat index');
  }
  if (typeof value.ready !== 'boolean') {
    fail('Lobby ready state must be boolean');
  }
  if (value.ready && seat === null) {
    fail('A ready lobby player must be seated');
  }
  if (
    value.connectionStatus !== 'connected' &&
    value.connectionStatus !== 'disconnected'
  ) {
    fail('Lobby connection status is invalid');
  }
}

function fail(message: string): never {
  throw new LobbyInvariantError(message);
}

function isExactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.size &&
    keys.every((key) => expectedKeys.has(key))
  );
}
