const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type RoomId = string;
export type PlayerId = string;
export type CommandId = string;

export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

export function parseRoomId(value: unknown): RoomId | undefined {
  return isCanonicalUuidV4(value) ? value : undefined;
}

export function parsePlayerId(value: unknown): PlayerId | undefined {
  return isCanonicalUuidV4(value) ? value : undefined;
}

export function parseCommandId(value: unknown): CommandId | undefined {
  return isCanonicalUuidV4(value) ? value : undefined;
}
