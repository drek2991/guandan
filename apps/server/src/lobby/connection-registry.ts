import { parseRoomId, type PlayerId, type RoomId } from '@guandan/protocol';

export interface LobbyConnectionBinding {
  roomId: RoomId;
  playerId: PlayerId;
}

export interface LobbyConnectionMembership extends LobbyConnectionBinding {
  socketId: string;
}

export interface LobbyConnectionRegistry {
  bind(socketId: string, binding: LobbyConnectionBinding): void;
  get(socketId: string): LobbyConnectionBinding | undefined;
  listByRoomId(roomId: RoomId): readonly LobbyConnectionMembership[];
  unbindForRollback(socketId: string, binding: LobbyConnectionBinding): boolean;
}

export class LobbyConnectionAlreadyBoundError extends Error {
  constructor() {
    super('Lobby connection is already bound');
    this.name = 'LobbyConnectionAlreadyBoundError';
  }
}

export function createLobbyConnectionRegistry(): LobbyConnectionRegistry {
  const bindings = new Map<string, LobbyConnectionBinding>();

  return {
    bind(socketId, binding): void {
      if (bindings.has(socketId)) {
        throw new LobbyConnectionAlreadyBoundError();
      }
      bindings.set(socketId, Object.freeze({ ...binding }));
    },
    get(socketId): LobbyConnectionBinding | undefined {
      return bindings.get(socketId);
    },
    listByRoomId(roomId): readonly LobbyConnectionMembership[] {
      if (parseRoomId(roomId) === undefined) {
        throw new Error('Lobby room ID is invalid');
      }

      return Object.freeze(
        [...bindings.entries()]
          .filter(([, binding]) => binding.roomId === roomId)
          .map(([socketId, binding]) =>
            Object.freeze({ socketId, ...binding }),
          ),
      );
    },
    unbindForRollback(socketId, binding): boolean {
      const current = bindings.get(socketId);
      if (current === undefined) {
        return true;
      }
      if (
        current.roomId !== binding.roomId ||
        current.playerId !== binding.playerId
      ) {
        return false;
      }
      return bindings.delete(socketId);
    },
  };
}
