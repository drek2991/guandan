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

export interface LobbyRepository {
  insert(room: LobbyRoomState): LobbyRoomState;
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
