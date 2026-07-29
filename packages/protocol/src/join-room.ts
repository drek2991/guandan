import { parseCommandId, type CommandId } from './identifiers.js';
import {
  normalizeDisplayName,
  parseLobbyMutationSuccess,
  parseRoomCode,
  type DisplayName,
  type LobbyMutationSuccess,
  type RoomCode,
} from './lobby.js';

export const LOBBY_JOIN_ROOM_EVENT = 'lobby:join-room';
export const JOIN_ROOM_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'ROOM_NOT_FOUND',
  'COMMAND_ID_CONFLICT',
  'INVALID_LOBBY_STATE',
  'INTERNAL_ERROR',
  'ALREADY_IN_ROOM',
  'ROOM_FULL',
  'NAME_TAKEN',
] as const;

export type JoinRoomErrorCode = (typeof JOIN_ROOM_ERROR_CODES)[number];

export interface JoinRoomCommand {
  commandId: CommandId;
  roomCode: RoomCode;
  displayName: DisplayName;
}

export interface JoinRoomSuccess extends LobbyMutationSuccess {}

export interface JoinRoomErrorAcknowledgement {
  status: 'error';
  code: JoinRoomErrorCode;
  message: string;
  commandId?: CommandId;
}

export type JoinRoomAcknowledgement =
  JoinRoomSuccess | JoinRoomErrorAcknowledgement;

const COMMAND_KEYS = new Set(['commandId', 'roomCode', 'displayName']);
const SUCCESS_KEYS = new Set([
  'status',
  'commandId',
  'roomRevision',
  'snapshot',
]);
const ERROR_REQUIRED_KEYS = new Set(['status', 'code', 'message']);
const ERROR_OPTIONAL_KEYS = new Set(['commandId']);
const ERROR_CODE_SET = new Set<string>(JOIN_ROOM_ERROR_CODES);

export function parseJoinRoomCommand(
  value: unknown,
): JoinRoomCommand | undefined {
  if (!isExactRecord(value, COMMAND_KEYS)) {
    return undefined;
  }

  const commandId = parseCommandId(value.commandId);
  const roomCode = parseRoomCode(value.roomCode);
  const displayName = normalizeDisplayName(value.displayName);
  if (
    commandId === undefined ||
    roomCode === undefined ||
    displayName === undefined
  ) {
    return undefined;
  }

  return { commandId, roomCode, displayName };
}

export function parseJoinRoomSuccess(
  value: unknown,
): JoinRoomSuccess | undefined {
  if (!isExactRecord(value, SUCCESS_KEYS)) {
    return undefined;
  }

  const success = parseLobbyMutationSuccess(value);
  if (success === undefined) {
    return undefined;
  }

  const { snapshot } = success;
  const self = snapshot.players.find(
    (player) => player.playerId === snapshot.selfPlayerId,
  );
  if (
    success.roomRevision < 1 ||
    snapshot.players.length < 2 ||
    snapshot.players.length > 4 ||
    snapshot.selfPlayerId === snapshot.hostPlayerId ||
    self === undefined ||
    !self.isSelf ||
    self.isHost ||
    self.seat !== null ||
    self.ready ||
    self.connectionStatus !== 'connected' ||
    snapshot.capabilities.canChangeSettings ||
    snapshot.capabilities.canManageSeats ||
    snapshot.capabilities.canRemovePlayers ||
    snapshot.capabilities.canStartMatch ||
    snapshot.settings.hasPassword
  ) {
    return undefined;
  }

  return success;
}

export function parseJoinRoomErrorAcknowledgement(
  value: unknown,
): JoinRoomErrorAcknowledgement | undefined {
  if (
    !isRecord(value) ||
    !hasRequiredAndAllowedKeys(
      value,
      ERROR_REQUIRED_KEYS,
      ERROR_OPTIONAL_KEYS,
    ) ||
    value.status !== 'error' ||
    typeof value.code !== 'string' ||
    !ERROR_CODE_SET.has(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length < 1 ||
    value.message.length > 160
  ) {
    return undefined;
  }

  const commandId = Object.hasOwn(value, 'commandId')
    ? parseCommandId(value.commandId)
    : undefined;
  if (Object.hasOwn(value, 'commandId') && commandId === undefined) {
    return undefined;
  }

  return {
    status: 'error',
    code: value.code as JoinRoomErrorCode,
    message: value.message,
    ...(commandId === undefined ? {} : { commandId }),
  };
}

export function parseJoinRoomAcknowledgement(
  value: unknown,
): JoinRoomAcknowledgement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value.status === 'ok'
    ? parseJoinRoomSuccess(value)
    : parseJoinRoomErrorAcknowledgement(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  expectedKeys: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.size &&
    keys.every((key) => expectedKeys.has(key))
  );
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  requiredKeys: ReadonlySet<string>,
  optionalKeys: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return (
    [...requiredKeys].every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => requiredKeys.has(key) || optionalKeys.has(key))
  );
}
