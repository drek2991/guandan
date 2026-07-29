import {
  parseCommandId,
  parsePlayerId,
  parseRoomId,
  type CommandId,
  type PlayerId,
  type RoomId,
} from './identifiers.js';

export const INITIAL_LOBBY_REVISION = 0;
export const LOBBY_SNAPSHOT_VERSION = 1;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LOBBY_SEATS = [0, 1, 2, 3] as const;
export const LOBBY_START_BLOCKERS = [
  'NOT_FOUR_PLAYERS',
  'NOT_FOUR_SEATS_OCCUPIED',
  'NOT_ALL_PLAYERS_READY',
] as const;
export const LOBBY_ERROR_CODES = [
  'INVALID_PAYLOAD',
  'ROOM_NOT_FOUND',
  'NOT_ROOM_MEMBER',
  'NOT_AUTHORIZED',
  'STALE_REVISION',
  'COMMAND_ID_CONFLICT',
  'INVALID_LOBBY_STATE',
  'INTERNAL_ERROR',
] as const;

export type RoomRevision = number;
export type SeatIndex = (typeof LOBBY_SEATS)[number];
export type RoomCode = string;
export type DisplayName = string;
export type StartingLevel = 2 | 7;
export type TurnTimer = 'off' | 30 | 60;
export type LobbyConnectionStatus = 'connected' | 'disconnected';
export type LobbyStartBlocker = (typeof LOBBY_START_BLOCKERS)[number];
export type LobbyErrorCode = (typeof LOBBY_ERROR_CODES)[number];

export interface LobbySettingsV1 {
  startingLevel: StartingLevel;
  turnTimer: TurnTimer;
  hasPassword: boolean;
}

export interface LobbyPlayerSnapshotV1 {
  playerId: PlayerId;
  displayName: DisplayName;
  seat: SeatIndex | null;
  ready: boolean;
  connectionStatus: LobbyConnectionStatus;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyStartEligibility {
  eligible: boolean;
  blockers: LobbyStartBlocker[];
}

export interface LobbyCapabilitiesV1 {
  canChangeSettings: boolean;
  canManageSeats: boolean;
  canRemovePlayers: boolean;
  canStartMatch: boolean;
}

export interface LobbySnapshotV1 {
  version: 1;
  phase: 'lobby';
  roomId: RoomId;
  roomCode: RoomCode;
  revision: RoomRevision;
  selfPlayerId: PlayerId;
  hostPlayerId: PlayerId;
  settings: LobbySettingsV1;
  players: LobbyPlayerSnapshotV1[];
  startEligibility: LobbyStartEligibility;
  capabilities: LobbyCapabilitiesV1;
}

export interface LobbyMutationMetadata {
  commandId: CommandId;
  knownRevision: RoomRevision;
}

export interface LobbyMutationSuccess {
  status: 'ok';
  commandId: CommandId;
  roomRevision: RoomRevision;
  snapshot: LobbySnapshotV1;
}

export interface LobbyErrorAcknowledgement {
  status: 'error';
  code: LobbyErrorCode;
  message: string;
  commandId?: CommandId;
  currentRevision?: RoomRevision;
}

export type LobbyAcknowledgement =
  LobbyMutationSuccess | LobbyErrorAcknowledgement;

const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const WHITESPACE_RUN_PATTERN = /\s+/gu;
const LOBBY_SETTINGS_KEYS = new Set([
  'startingLevel',
  'turnTimer',
  'hasPassword',
]);
const LOBBY_PLAYER_KEYS = new Set([
  'playerId',
  'displayName',
  'seat',
  'ready',
  'connectionStatus',
  'isHost',
  'isSelf',
]);
const START_ELIGIBILITY_KEYS = new Set(['eligible', 'blockers']);
const CAPABILITIES_KEYS = new Set([
  'canChangeSettings',
  'canManageSeats',
  'canRemovePlayers',
  'canStartMatch',
]);
const SNAPSHOT_KEYS = new Set([
  'version',
  'phase',
  'roomId',
  'roomCode',
  'revision',
  'selfPlayerId',
  'hostPlayerId',
  'settings',
  'players',
  'startEligibility',
  'capabilities',
]);
const MUTATION_METADATA_KEYS = new Set(['commandId', 'knownRevision']);
const MUTATION_SUCCESS_KEYS = new Set([
  'status',
  'commandId',
  'roomRevision',
  'snapshot',
]);
const ERROR_REQUIRED_KEYS = new Set(['status', 'code', 'message']);
const ERROR_OPTIONAL_KEYS = new Set(['commandId', 'currentRevision']);
const START_BLOCKER_SET = new Set<string>(LOBBY_START_BLOCKERS);
const ERROR_CODE_SET = new Set<string>(LOBBY_ERROR_CODES);

export function parseRoomRevision(value: unknown): RoomRevision | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= INITIAL_LOBBY_REVISION
    ? value
    : undefined;
}

export function parseSeatIndex(value: unknown): SeatIndex | undefined {
  return typeof value === 'number' && LOBBY_SEATS.includes(value as SeatIndex)
    ? (value as SeatIndex)
    : undefined;
}

export function getPartnerSeat(seat: SeatIndex): SeatIndex {
  return ((seat + 2) % 4) as SeatIndex;
}

export function parseRoomCode(value: unknown): RoomCode | undefined {
  return typeof value === 'string' && ROOM_CODE_PATTERN.test(value)
    ? value
    : undefined;
}

export function normalizeDisplayName(value: unknown): DisplayName | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const unicodeNormalized = value.normalize('NFKC');
  if (
    CONTROL_CHARACTER_PATTERN.test(unicodeNormalized) ||
    unicodeNormalized.includes(LINE_SEPARATOR) ||
    unicodeNormalized.includes(PARAGRAPH_SEPARATOR)
  ) {
    return undefined;
  }

  const normalized = unicodeNormalized
    .trim()
    .replace(WHITESPACE_RUN_PATTERN, ' ');
  const codePointCount = [...normalized].length;

  return codePointCount >= 1 && codePointCount <= 24 ? normalized : undefined;
}

export function parseDisplayName(value: unknown): DisplayName | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = normalizeDisplayName(value);
  return normalized === value ? normalized : undefined;
}

export function deriveDisplayNameKey(value: string): string | undefined {
  const normalized = normalizeDisplayName(value);
  return normalized?.toLocaleLowerCase('en-US');
}

export function parseStartingLevel(value: unknown): StartingLevel | undefined {
  return value === 2 || value === 7 ? value : undefined;
}

export function parseTurnTimer(value: unknown): TurnTimer | undefined {
  return value === 'off' || value === 30 || value === 60 ? value : undefined;
}

export function parseLobbySettingsV1(
  value: unknown,
): LobbySettingsV1 | undefined {
  if (!isExactRecord(value, LOBBY_SETTINGS_KEYS)) {
    return undefined;
  }

  const startingLevel = parseStartingLevel(value.startingLevel);
  const turnTimer = parseTurnTimer(value.turnTimer);
  if (
    startingLevel === undefined ||
    turnTimer === undefined ||
    typeof value.hasPassword !== 'boolean'
  ) {
    return undefined;
  }

  return { startingLevel, turnTimer, hasPassword: value.hasPassword };
}

export function parseLobbyPlayerSnapshotV1(
  value: unknown,
): LobbyPlayerSnapshotV1 | undefined {
  if (!isExactRecord(value, LOBBY_PLAYER_KEYS)) {
    return undefined;
  }

  const playerId = parsePlayerId(value.playerId);
  const displayName = parseDisplayName(value.displayName);
  const seat = value.seat === null ? null : parseSeatIndex(value.seat);
  if (
    playerId === undefined ||
    displayName === undefined ||
    seat === undefined ||
    typeof value.ready !== 'boolean' ||
    (value.connectionStatus !== 'connected' &&
      value.connectionStatus !== 'disconnected') ||
    typeof value.isHost !== 'boolean' ||
    typeof value.isSelf !== 'boolean' ||
    (value.ready && seat === null)
  ) {
    return undefined;
  }

  return {
    playerId,
    displayName,
    seat,
    ready: value.ready,
    connectionStatus: value.connectionStatus,
    isHost: value.isHost,
    isSelf: value.isSelf,
  };
}

export function parseLobbyStartEligibility(
  value: unknown,
): LobbyStartEligibility | undefined {
  if (
    !isExactRecord(value, START_ELIGIBILITY_KEYS) ||
    typeof value.eligible !== 'boolean' ||
    !Array.isArray(value.blockers)
  ) {
    return undefined;
  }

  const blockers = value.blockers;
  let previousBlockerIndex = -1;
  for (const blocker of blockers) {
    if (typeof blocker !== 'string' || !START_BLOCKER_SET.has(blocker)) {
      return undefined;
    }

    const blockerIndex = LOBBY_START_BLOCKERS.indexOf(
      blocker as LobbyStartBlocker,
    );
    if (blockerIndex <= previousBlockerIndex) {
      return undefined;
    }
    previousBlockerIndex = blockerIndex;
  }

  if (
    blockers.length > LOBBY_START_BLOCKERS.length ||
    value.eligible !== (blockers.length === 0)
  ) {
    return undefined;
  }

  return {
    eligible: value.eligible,
    blockers: blockers as LobbyStartBlocker[],
  };
}

export function parseLobbyCapabilitiesV1(
  value: unknown,
): LobbyCapabilitiesV1 | undefined {
  if (!isExactRecord(value, CAPABILITIES_KEYS)) {
    return undefined;
  }

  if (
    typeof value.canChangeSettings !== 'boolean' ||
    typeof value.canManageSeats !== 'boolean' ||
    typeof value.canRemovePlayers !== 'boolean' ||
    typeof value.canStartMatch !== 'boolean'
  ) {
    return undefined;
  }

  return {
    canChangeSettings: value.canChangeSettings,
    canManageSeats: value.canManageSeats,
    canRemovePlayers: value.canRemovePlayers,
    canStartMatch: value.canStartMatch,
  };
}

export function parseLobbySnapshotV1(
  value: unknown,
): LobbySnapshotV1 | undefined {
  if (!isExactRecord(value, SNAPSHOT_KEYS)) {
    return undefined;
  }

  const roomId = parseRoomId(value.roomId);
  const roomCode = parseRoomCode(value.roomCode);
  const revision = parseRoomRevision(value.revision);
  const selfPlayerId = parsePlayerId(value.selfPlayerId);
  const hostPlayerId = parsePlayerId(value.hostPlayerId);
  const settings = parseLobbySettingsV1(value.settings);
  const startEligibility = parseLobbyStartEligibility(value.startEligibility);
  const capabilities = parseLobbyCapabilitiesV1(value.capabilities);

  if (
    value.version !== LOBBY_SNAPSHOT_VERSION ||
    value.phase !== 'lobby' ||
    roomId === undefined ||
    roomCode === undefined ||
    revision === undefined ||
    selfPlayerId === undefined ||
    hostPlayerId === undefined ||
    settings === undefined ||
    startEligibility === undefined ||
    capabilities === undefined ||
    !Array.isArray(value.players) ||
    value.players.length < 1 ||
    value.players.length > 4
  ) {
    return undefined;
  }

  const players: LobbyPlayerSnapshotV1[] = [];
  const playerIds = new Set<string>();
  const displayNameKeys = new Set<string>();
  const occupiedSeats = new Set<SeatIndex>();

  for (const rawPlayer of value.players) {
    const player = parseLobbyPlayerSnapshotV1(rawPlayer);
    const displayNameKey =
      player === undefined
        ? undefined
        : deriveDisplayNameKey(player.displayName);
    if (
      player === undefined ||
      displayNameKey === undefined ||
      playerIds.has(player.playerId) ||
      displayNameKeys.has(displayNameKey) ||
      (player.seat !== null && occupiedSeats.has(player.seat))
    ) {
      return undefined;
    }

    players.push(player);
    playerIds.add(player.playerId);
    displayNameKeys.add(displayNameKey);
    if (player.seat !== null) {
      occupiedSeats.add(player.seat);
    }
  }

  const expectedBlockers = derivePublicStartBlockers(
    players,
    occupiedSeats.size,
  );
  const selfCount = players.filter((player) => player.isSelf).length;
  const hostCount = players.filter((player) => player.isHost).length;
  const selfPlayer = players.find((player) => player.playerId === selfPlayerId);
  const hostPlayer = players.find((player) => player.playerId === hostPlayerId);
  const viewerIsHost = selfPlayerId === hostPlayerId;

  if (
    selfPlayer === undefined ||
    hostPlayer === undefined ||
    selfCount !== 1 ||
    hostCount !== 1 ||
    !selfPlayer.isSelf ||
    !hostPlayer.isHost ||
    players.some(
      (player) =>
        player.isSelf !== (player.playerId === selfPlayerId) ||
        player.isHost !== (player.playerId === hostPlayerId),
    ) ||
    !sameArray(startEligibility.blockers, expectedBlockers) ||
    startEligibility.eligible !== (expectedBlockers.length === 0) ||
    !capabilitiesMatch(capabilities, viewerIsHost, startEligibility.eligible)
  ) {
    return undefined;
  }

  return {
    version: LOBBY_SNAPSHOT_VERSION,
    phase: 'lobby',
    roomId,
    roomCode,
    revision,
    selfPlayerId,
    hostPlayerId,
    settings,
    players,
    startEligibility,
    capabilities,
  };
}

export function parseLobbyMutationMetadata(
  value: unknown,
): LobbyMutationMetadata | undefined {
  if (!isExactRecord(value, MUTATION_METADATA_KEYS)) {
    return undefined;
  }

  const commandId = parseCommandId(value.commandId);
  const knownRevision = parseRoomRevision(value.knownRevision);
  return commandId === undefined || knownRevision === undefined
    ? undefined
    : { commandId, knownRevision };
}

export function parseLobbyMutationSuccess(
  value: unknown,
): LobbyMutationSuccess | undefined {
  if (!isExactRecord(value, MUTATION_SUCCESS_KEYS) || value.status !== 'ok') {
    return undefined;
  }

  const commandId = parseCommandId(value.commandId);
  const roomRevision = parseRoomRevision(value.roomRevision);
  const snapshot = parseLobbySnapshotV1(value.snapshot);
  if (
    commandId === undefined ||
    roomRevision === undefined ||
    snapshot === undefined ||
    roomRevision !== snapshot.revision
  ) {
    return undefined;
  }

  return { status: 'ok', commandId, roomRevision, snapshot };
}

export function parseLobbyErrorAcknowledgement(
  value: unknown,
): LobbyErrorAcknowledgement | undefined {
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
  if (
    (Object.hasOwn(value, 'commandId') && commandId === undefined) ||
    (Object.hasOwn(value, 'currentRevision') && currentRevision === undefined)
  ) {
    return undefined;
  }

  return {
    status: 'error',
    code: value.code as LobbyErrorCode,
    message: value.message,
    ...(commandId === undefined ? {} : { commandId }),
    ...(currentRevision === undefined ? {} : { currentRevision }),
  };
}

export function parseLobbyAcknowledgement(
  value: unknown,
): LobbyAcknowledgement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value.status === 'ok'
    ? parseLobbyMutationSuccess(value)
    : parseLobbyErrorAcknowledgement(value);
}

function derivePublicStartBlockers(
  players: readonly LobbyPlayerSnapshotV1[],
  occupiedSeatCount: number,
): LobbyStartBlocker[] {
  const blockers: LobbyStartBlocker[] = [];
  if (players.length !== 4) {
    blockers.push('NOT_FOUR_PLAYERS');
  }
  if (occupiedSeatCount !== 4) {
    blockers.push('NOT_FOUR_SEATS_OCCUPIED');
  }
  if (!players.every((player) => player.ready)) {
    blockers.push('NOT_ALL_PLAYERS_READY');
  }
  return blockers;
}

function capabilitiesMatch(
  capabilities: LobbyCapabilitiesV1,
  viewerIsHost: boolean,
  startEligible: boolean,
): boolean {
  return (
    capabilities.canChangeSettings === viewerIsHost &&
    capabilities.canManageSeats === viewerIsHost &&
    capabilities.canRemovePlayers === viewerIsHost &&
    capabilities.canStartMatch === (viewerIsHost && startEligible)
  );
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
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
