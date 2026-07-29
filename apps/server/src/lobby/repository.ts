import type { RoomCode, RoomId } from '@guandan/protocol';

import { assertValidLobbyRoomState } from './invariants.js';
import type { LobbyRoomState } from './model.js';

export type LobbyRepositoryInsertFailure =
  'duplicate-room-id' | 'duplicate-room-code';

export class LobbyRepositoryInsertError extends Error {
  constructor(readonly failure: LobbyRepositoryInsertFailure) {
    super('Lobby repository insert failed');
    this.name = 'LobbyRepositoryInsertError';
  }
}

export type LobbyRepositoryReplaceFailure =
  | 'missing-room'
  | 'revision-mismatch'
  | 'revision-overflow'
  | 'room-id-change'
  | 'room-code-change'
  | 'existing-state-change'
  | 'index-inconsistent'
  | 'rollback-state-mismatch';

export class LobbyRepositoryReplaceError extends Error {
  constructor(readonly failure: LobbyRepositoryReplaceFailure) {
    super('Lobby repository replacement failed');
    this.name = 'LobbyRepositoryReplaceError';
  }
}

export interface ReplaceLobbyRoomInput {
  roomId: RoomId;
  expectedRevision: number;
  nextRoom: LobbyRoomState;
}

export interface ReplaceLobbyRoomResult {
  previousRoom: LobbyRoomState;
  storedRoom: LobbyRoomState;
}

export interface RestoreLobbyRoomInput {
  roomId: RoomId;
  expectedCurrentRevision: number;
  previousRoom: LobbyRoomState;
}

export interface LobbyRepository {
  insert(room: LobbyRoomState): LobbyRoomState;
  replaceRoom(input: ReplaceLobbyRoomInput): ReplaceLobbyRoomResult;
  restoreRoomForRollback(input: RestoreLobbyRoomInput): LobbyRoomState;
  getById(roomId: RoomId): LobbyRoomState | undefined;
  getByCode(roomCode: RoomCode): LobbyRoomState | undefined;
  hasRoomCode(roomCode: RoomCode): boolean;
  deleteForRollback(roomId: RoomId): boolean;
  count(): number;
}

export function createInMemoryLobbyRepository(): LobbyRepository {
  const roomsById = new Map<RoomId, LobbyRoomState>();
  const roomIdsByCode = new Map<RoomCode, RoomId>();

  return {
    insert(room): LobbyRoomState {
      assertValidLobbyRoomState(room);
      if (roomsById.has(room.roomId)) {
        throw new LobbyRepositoryInsertError('duplicate-room-id');
      }
      if (roomIdsByCode.has(room.roomCode)) {
        throw new LobbyRepositoryInsertError('duplicate-room-code');
      }

      const storedRoom = cloneAndFreezeRoom(room);
      roomsById.set(storedRoom.roomId, storedRoom);
      roomIdsByCode.set(storedRoom.roomCode, storedRoom.roomId);
      return storedRoom;
    },
    replaceRoom({
      roomId,
      expectedRevision,
      nextRoom,
    }): ReplaceLobbyRoomResult {
      const previousRoom = roomsById.get(roomId);
      if (previousRoom === undefined) {
        throw new LobbyRepositoryReplaceError('missing-room');
      }
      if (roomIdsByCode.get(previousRoom.roomCode) !== roomId) {
        throw new LobbyRepositoryReplaceError('index-inconsistent');
      }
      if (previousRoom.revision !== expectedRevision) {
        throw new LobbyRepositoryReplaceError('revision-mismatch');
      }
      if (expectedRevision === Number.MAX_SAFE_INTEGER) {
        throw new LobbyRepositoryReplaceError('revision-overflow');
      }
      if (nextRoom.roomId !== roomId) {
        throw new LobbyRepositoryReplaceError('room-id-change');
      }
      if (nextRoom.roomCode !== previousRoom.roomCode) {
        throw new LobbyRepositoryReplaceError('room-code-change');
      }
      if (nextRoom.revision !== expectedRevision + 1) {
        throw new LobbyRepositoryReplaceError('revision-mismatch');
      }
      if (
        nextRoom.phase !== previousRoom.phase ||
        nextRoom.hostPlayerId !== previousRoom.hostPlayerId ||
        !settingsEqual(nextRoom, previousRoom) ||
        nextRoom.players.length !== previousRoom.players.length + 1 ||
        !previousRoom.players.every((player, index) =>
          playerEqual(player, nextRoom.players[index]),
        )
      ) {
        throw new LobbyRepositoryReplaceError('existing-state-change');
      }

      assertValidLobbyRoomState(nextRoom);
      const storedRoom = cloneAndFreezeRoom(nextRoom);
      roomsById.set(roomId, storedRoom);
      return { previousRoom, storedRoom };
    },
    restoreRoomForRollback({
      roomId,
      expectedCurrentRevision,
      previousRoom,
    }): LobbyRoomState {
      const currentRoom = roomsById.get(roomId);
      if (
        currentRoom === undefined ||
        currentRoom.revision !== expectedCurrentRevision ||
        currentRoom.roomId !== roomId ||
        previousRoom.roomId !== roomId ||
        currentRoom.roomCode !== previousRoom.roomCode ||
        roomIdsByCode.get(previousRoom.roomCode) !== roomId ||
        previousRoom.revision + 1 !== expectedCurrentRevision
      ) {
        throw new LobbyRepositoryReplaceError('rollback-state-mismatch');
      }

      assertValidLobbyRoomState(previousRoom);
      const storedPreviousRoom = cloneAndFreezeRoom(previousRoom);
      roomsById.set(roomId, storedPreviousRoom);
      return storedPreviousRoom;
    },
    getById(roomId): LobbyRoomState | undefined {
      return roomsById.get(roomId);
    },
    getByCode(roomCode): LobbyRoomState | undefined {
      const roomId = roomIdsByCode.get(roomCode);
      return roomId === undefined ? undefined : roomsById.get(roomId);
    },
    hasRoomCode(roomCode): boolean {
      return roomIdsByCode.has(roomCode);
    },
    deleteForRollback(roomId): boolean {
      const room = roomsById.get(roomId);
      if (room === undefined) {
        return false;
      }

      roomsById.delete(roomId);
      if (roomIdsByCode.get(room.roomCode) === roomId) {
        roomIdsByCode.delete(room.roomCode);
      }
      return true;
    },
    count(): number {
      return roomsById.size;
    },
  };
}

function settingsEqual(left: LobbyRoomState, right: LobbyRoomState): boolean {
  return (
    left.settings.startingLevel === right.settings.startingLevel &&
    left.settings.turnTimer === right.settings.turnTimer &&
    left.settings.hasPassword === right.settings.hasPassword
  );
}

function playerEqual(
  left: LobbyRoomState['players'][number],
  right: LobbyRoomState['players'][number] | undefined,
): boolean {
  return (
    right !== undefined &&
    left.playerId === right.playerId &&
    left.displayName === right.displayName &&
    left.displayNameKey === right.displayNameKey &&
    left.joinOrder === right.joinOrder &&
    left.seat === right.seat &&
    left.ready === right.ready &&
    left.connectionStatus === right.connectionStatus
  );
}

function cloneAndFreezeRoom(room: LobbyRoomState): LobbyRoomState {
  const settings = Object.freeze({ ...room.settings });
  const players = Object.freeze(
    room.players.map((player) => Object.freeze({ ...player })),
  );
  return Object.freeze({
    ...room,
    settings,
    players,
  }) as LobbyRoomState;
}
