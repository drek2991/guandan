import { parseCommandId, type CommandId } from './identifiers.js';
import {
  parseLobbyMutationSuccess,
  parseRoomRevision,
  parseSeatIndex,
  type LobbyMutationSuccess,
  type RoomRevision,
  type SeatIndex,
} from './lobby.js';

export const LOBBY_SET_SEAT_EVENT = 'lobby:set-seat';
export const SET_SEAT_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'NOT_ROOM_MEMBER',
  'STALE_REVISION',
  'COMMAND_ID_CONFLICT',
  'SEAT_TAKEN',
  'INVALID_LOBBY_STATE',
  'INTERNAL_ERROR',
] as const;

export type SetSeatErrorCode = (typeof SET_SEAT_ERROR_CODES)[number];

export interface SetSeatCommand {
  commandId: CommandId;
  knownRevision: RoomRevision;
  seat: SeatIndex | null;
}

export interface SetSeatSuccess extends LobbyMutationSuccess {}

export interface SetSeatErrorAcknowledgement {
  status: 'error';
  code: SetSeatErrorCode;
  message: string;
  commandId?: CommandId;
  currentRevision?: RoomRevision;
}

export type SetSeatAcknowledgement =
  SetSeatSuccess | SetSeatErrorAcknowledgement;

const COMMAND_KEYS = new Set(['commandId', 'knownRevision', 'seat']);
const ERROR_REQUIRED_KEYS = new Set(['status', 'code', 'message']);
const ERROR_OPTIONAL_KEYS = new Set(['commandId', 'currentRevision']);
const ERROR_CODE_SET = new Set<string>(SET_SEAT_ERROR_CODES);

export function parseSetSeatCommand(
  value: unknown,
): SetSeatCommand | undefined {
  if (!isExactRecord(value, COMMAND_KEYS)) {
    return undefined;
  }

  const commandId = parseCommandId(value.commandId);
  const knownRevision = parseRoomRevision(value.knownRevision);
  const seat = value.seat === null ? null : parseSeatIndex(value.seat);
  if (
    commandId === undefined ||
    knownRevision === undefined ||
    seat === undefined
  ) {
    return undefined;
  }

  return { commandId, knownRevision, seat };
}

export function parseSetSeatSuccess(
  value: unknown,
): SetSeatSuccess | undefined {
  const success = parseLobbyMutationSuccess(value);
  if (success === undefined) {
    return undefined;
  }

  const self = success.snapshot.players.find(
    (player) => player.playerId === success.snapshot.selfPlayerId,
  );
  return self === undefined ? undefined : success;
}

export function parseSetSeatErrorAcknowledgement(
  value: unknown,
): SetSeatErrorAcknowledgement | undefined {
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
  const currentRevision = Object.hasOwn(value, 'currentRevision')
    ? parseRoomRevision(value.currentRevision)
    : undefined;
  const hasCurrentRevision = Object.hasOwn(value, 'currentRevision');
  if (
    (Object.hasOwn(value, 'commandId') && commandId === undefined) ||
    (hasCurrentRevision && currentRevision === undefined) ||
    (value.code === 'STALE_REVISION') !== hasCurrentRevision
  ) {
    return undefined;
  }

  return {
    status: 'error',
    code: value.code as SetSeatErrorCode,
    message: value.message,
    ...(commandId === undefined ? {} : { commandId }),
    ...(currentRevision === undefined ? {} : { currentRevision }),
  };
}

export function parseSetSeatAcknowledgement(
  value: unknown,
): SetSeatAcknowledgement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value.status === 'ok'
    ? parseSetSeatSuccess(value)
    : parseSetSeatErrorAcknowledgement(value);
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
