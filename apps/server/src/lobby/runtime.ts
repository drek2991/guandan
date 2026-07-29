import type { CreateRoomAcknowledgement } from '@guandan/protocol';

import { createLobbyConnectionRegistry } from './connection-registry.js';
import { createCreateRoomReceiptStore } from './create-receipts.js';
import { createCreateRoomService } from './create-room.js';
import { createInMemoryLobbyRepository } from './repository.js';
import { createRoomCodeAllocator } from './room-code.js';

export interface LobbyRuntime {
  createRoom(socketId: string, rawCommand: unknown): CreateRoomAcknowledgement;
}

export function createLobbyRuntime(): LobbyRuntime {
  const repository = createInMemoryLobbyRepository();
  const connectionRegistry = createLobbyConnectionRegistry();
  const receiptStore = createCreateRoomReceiptStore();
  const roomCodeAllocator = createRoomCodeAllocator(repository);
  const service = createCreateRoomService({
    repository,
    roomCodeAllocator,
    connectionRegistry,
    receiptStore,
  });

  return {
    createRoom: (socketId, rawCommand) => service.create(socketId, rawCommand),
  };
}
