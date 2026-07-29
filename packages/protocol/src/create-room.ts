import {
  INITIAL_LOBBY_REVISION,
  normalizeDisplayName,
  parseLobbyMutationSuccess,
  parseStartingLevel,
  parseTurnTimer,
  type DisplayName,
  type LobbyMutationSuccess,
  type StartingLevel,
  type TurnTimer,
} from './lobby.js';
import { parseCommandId, type CommandId } from './identifiers.js';

export const LOBBY_CREATE_ROOM_EVENT = 'lobby:create-room';
export const CREATE_ROOM_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'COMMAND_ID_CONFLICT',
  'INVALID_LOBBY_STATE',
  'INTERNAL_ERROR',
  'ALREADY_IN_ROOM',
  'ROOM_CODE_UNAVAILABLE',
] as const;

export type CreateRoomErrorCode = (typeof CREATE_ROOM_ERROR_CODES)[number];

export interface CreateRoomSettings {
  startingLevel: StartingLevel;
  turnTimer: TurnTimer;
}

export interface CreateRoomCommand {
  commandId: CommandId;
  displayName: DisplayName;
  settings: CreateRoomSettings;
}

export interface CreateRoomSuccess extends LobbyMutationSuccess {}

export interface CreateRoomErrorAcknowledgement {
  status: 'error';
  code: CreateRoomErrorCode;
  message: string;
  commandId?: CommandId;
}

export type CreateRoomAcknowledgement =
  CreateRoomSuccess | CreateRoomErrorAcknowledgement;

const COMMAND_KEYS = new Set(['commandId', 'displayName', 'settings']);
const SETTINGS_KEYS = new Set(['startingLevel', 'turnTimer']);
const SUCCESS_KEYS = new Set([
  'status',
  'commandId',
  'roomRevision',
  'snapshot',
]);
const ERROR_REQUIRED_KEYS = new Set(['status', 'code', 'message']);
const ERROR_OPTIONAL_KEYS = new Set(['commandId']);
const ERROR_CODE_SET = new Set<string>(CREATE_ROOM_ERROR_CODES);

export function parseCreateRoomCommand(
  value: unknown,
): CreateRoomCommand | undefined {
  if (!isExactRecord(value, COMMAND_KEYS)) {
    return undefined;
  }

  const commandId = parseCommandId(value.commandId);
  const displayName = normalizeDisplayName(value.displayName);
  const settings = parseCreateRoomSettings(value.settings);
  if (
    commandId === undefined ||
    displayName === undefined ||
    settings === undefined
  ) {
    return undefined;
  }

  return { commandId, displayName, settings };
}

export function parseCreateRoomSuccess(
  value: unknown,
): CreateRoomSuccess | undefined {
  if (!isExactRecord(value, SUCCESS_KEYS)) {
    return undefined;
  }

  const success = parseLobbyMutationSuccess(value);
  if (success === undefined) {
    return undefined;
  }

  const { snapshot } = success;
  const creator = snapshot.players[0];
  if (
    success.roomRevision !== INITIAL_LOBBY_REVISION ||
    snapshot.selfPlayerId !== snapshot.hostPlayerId ||
    snapshot.players.length !== 1 ||
    creator === undefined ||
    creator.playerId !== snapshot.selfPlayerId ||
    !creator.isSelf ||
    !creator.isHost ||
    creator.seat !== null ||
    creator.ready ||
    creator.connectionStatus !== 'connected' ||
    !snapshot.capabilities.canChangeSettings ||
    !snapshot.capabilities.canManageSeats ||
    !snapshot.capabilities.canRemovePlayers ||
    snapshot.capabilities.canStartMatch ||
    snapshot.settings.hasPassword
  ) {
    return undefined;
  }

  return success;
}

export function parseCreateRoomErrorAcknowledgement(
  value: unknown,
): CreateRoomErrorAcknowledgement | undefined {
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
    code: value.code as CreateRoomErrorCode,
    message: value.message,
    ...(commandId === undefined ? {} : { commandId }),
  };
}

export function parseCreateRoomAcknowledgement(
  value: unknown,
): CreateRoomAcknowledgement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value.status === 'ok'
    ? parseCreateRoomSuccess(value)
    : parseCreateRoomErrorAcknowledgement(value);
}

function parseCreateRoomSettings(
  value: unknown,
): CreateRoomSettings | undefined {
  if (!isExactRecord(value, SETTINGS_KEYS)) {
    return undefined;
  }

  const startingLevel = parseStartingLevel(value.startingLevel);
  const turnTimer = parseTurnTimer(value.turnTimer);
  return startingLevel === undefined || turnTimer === undefined
    ? undefined
    : { startingLevel, turnTimer };
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
