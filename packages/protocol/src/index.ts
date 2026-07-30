import {
  LOBBY_CREATE_ROOM_EVENT,
  type CreateRoomAcknowledgement,
} from './create-room.js';
import { isCanonicalUuidV4 } from './identifiers.js';
import {
  LOBBY_JOIN_ROOM_EVENT,
  type JoinRoomAcknowledgement,
} from './join-room.js';
import { LOBBY_SNAPSHOT_EVENT, type LobbySnapshotV1 } from './lobby.js';

export * from './create-room.js';
export * from './identifiers.js';
export * from './join-room.js';
export * from './lobby.js';

export const SCAFFOLD_PING_EVENT = 'scaffold:ping';
export const INFRASTRUCTURE_DATABASE_SMOKE_EVENT =
  'infrastructure:database-smoke';

export const INFRASTRUCTURE_SMOKE_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'DATABASE_UNAVAILABLE',
  'DATABASE_WRITE_FAILED',
  'DATABASE_READBACK_MISMATCH',
  'INTERNAL_ERROR',
] as const;

export type InfrastructureSmokeErrorCode =
  (typeof INFRASTRUCTURE_SMOKE_ERROR_CODES)[number];

export interface InfrastructureDatabaseSmokeCommand {
  commandId: string;
  probeToken: string;
}

export interface InfrastructureDatabaseSmokeSuccess {
  status: 'ok';
  commandId: string;
  probeToken: string;
  databaseVerified: true;
  operation: 'upsert-readback';
  databaseUpdatedAt: string;
  completedAt: string;
}

export interface InfrastructureDatabaseSmokeFailure {
  status: 'error';
  code: InfrastructureSmokeErrorCode;
  message: string;
  commandId?: string;
}

export type InfrastructureDatabaseSmokeAcknowledgement =
  InfrastructureDatabaseSmokeSuccess | InfrastructureDatabaseSmokeFailure;

export interface ScaffoldClientToServerEvents {
  [SCAFFOLD_PING_EVENT]: (
    acknowledge: (response: ScaffoldPingResponse) => void,
  ) => void;
  [INFRASTRUCTURE_DATABASE_SMOKE_EVENT]: (
    command: unknown,
    acknowledge: (response: InfrastructureDatabaseSmokeAcknowledgement) => void,
  ) => void;
  [LOBBY_CREATE_ROOM_EVENT]: (
    command: unknown,
    acknowledge: (response: CreateRoomAcknowledgement) => void,
  ) => void;
  [LOBBY_JOIN_ROOM_EVENT]: (
    command: unknown,
    acknowledge: (response: JoinRoomAcknowledgement) => void,
  ) => void;
}

export interface ScaffoldServerToClientEvents {
  [LOBBY_SNAPSHOT_EVENT]: (snapshot: LobbySnapshotV1) => void;
}

export interface ScaffoldPingResponse {
  status: 'ok';
}

const COMMAND_KEYS = new Set(['commandId', 'probeToken']);
const SUCCESS_KEYS = new Set([
  'status',
  'commandId',
  'probeToken',
  'databaseVerified',
  'operation',
  'databaseUpdatedAt',
  'completedAt',
]);
const FAILURE_KEYS_WITH_COMMAND_ID = new Set([
  'status',
  'code',
  'message',
  'commandId',
]);
const FAILURE_KEYS_WITHOUT_COMMAND_ID = new Set(['status', 'code', 'message']);
const ERROR_CODE_SET = new Set<string>(INFRASTRUCTURE_SMOKE_ERROR_CODES);

export function isInfrastructureSmokeIdentifier(
  value: unknown,
): value is string {
  return isCanonicalUuidV4(value);
}

export function parseInfrastructureDatabaseSmokeCommand(
  value: unknown,
): InfrastructureDatabaseSmokeCommand | undefined {
  if (!isExactRecord(value, COMMAND_KEYS)) {
    return undefined;
  }

  const { commandId, probeToken } = value;

  if (
    !isInfrastructureSmokeIdentifier(commandId) ||
    !isInfrastructureSmokeIdentifier(probeToken)
  ) {
    return undefined;
  }

  return { commandId, probeToken };
}

export function parseInfrastructureDatabaseSmokeAcknowledgement(
  value: unknown,
): InfrastructureDatabaseSmokeAcknowledgement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.status === 'ok') {
    if (
      !isExactRecord(value, SUCCESS_KEYS) ||
      !isInfrastructureSmokeIdentifier(value.commandId) ||
      !isInfrastructureSmokeIdentifier(value.probeToken) ||
      value.databaseVerified !== true ||
      value.operation !== 'upsert-readback' ||
      !isIsoTimestamp(value.databaseUpdatedAt) ||
      !isIsoTimestamp(value.completedAt)
    ) {
      return undefined;
    }

    return {
      status: 'ok',
      commandId: value.commandId,
      probeToken: value.probeToken,
      databaseVerified: true,
      operation: 'upsert-readback',
      databaseUpdatedAt: value.databaseUpdatedAt,
      completedAt: value.completedAt,
    };
  }

  if (value.status !== 'error') {
    return undefined;
  }

  const hasCommandId = Object.hasOwn(value, 'commandId');
  const expectedKeys = hasCommandId
    ? FAILURE_KEYS_WITH_COMMAND_ID
    : FAILURE_KEYS_WITHOUT_COMMAND_ID;

  if (
    !isExactRecord(value, expectedKeys) ||
    !isInfrastructureSmokeErrorCode(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 160 ||
    (hasCommandId && !isInfrastructureSmokeIdentifier(value.commandId))
  ) {
    return undefined;
  }

  return {
    status: 'error',
    code: value.code,
    message: value.message,
    ...(hasCommandId ? { commandId: value.commandId as string } : {}),
  };
}

function isInfrastructureSmokeErrorCode(
  value: unknown,
): value is InfrastructureSmokeErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
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
