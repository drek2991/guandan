import type { PlayerId, RoomId } from '@guandan/protocol';

export interface LobbyConnectionBinding {
  roomId: RoomId;
  playerId: PlayerId;
}

export interface LobbyConnectionRegistry {
  bind(socketId: string, binding: LobbyConnectionBinding): void;
  get(socketId: string): LobbyConnectionBinding | undefined;
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
    unbindForRollback(socketId, binding): boolean {
      const current = bindings.get(socketId);
      if (
        current === undefined ||
        current.roomId !== binding.roomId ||
        current.playerId !== binding.playerId
      ) {
        return false;
      }
      return bindings.delete(socketId);
    },
  };
}
