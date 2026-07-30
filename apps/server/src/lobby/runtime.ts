import { randomUUID } from 'node:crypto';

import type {
  CreateRoomAcknowledgement,
  JoinRoomAcknowledgement,
  RoomId,
  SetSeatAcknowledgement,
} from '@guandan/protocol';

import { createLobbyCommandReceiptStore } from './command-receipts.js';
import { createLobbyConnectionRegistry } from './connection-registry.js';
import { createCreateRoomService } from './create-room.js';
import { createJoinRoomService } from './join-room.js';
import { createInMemoryLobbyRepository } from './repository.js';
import { createRoomCodeAllocator } from './room-code.js';
import { createSetSeatService } from './set-seat.js';
import {
  createLobbySnapshotDeliveryPlanner,
  type LobbySnapshotDeliveryPlan,
} from './snapshot-delivery.js';

export interface LobbyRuntime {
  createRoom(socketId: string, rawCommand: unknown): CreateRoomAcknowledgement;
  joinRoom(socketId: string, rawCommand: unknown): JoinRoomAcknowledgement;
  setSeat(socketId: string, rawCommand: unknown): SetSeatAcknowledgement;
  prepareLobbySnapshotDeliveries(roomId: RoomId): LobbySnapshotDeliveryPlan;
}

export function createLobbyRuntime(): LobbyRuntime {
  const repository = createInMemoryLobbyRepository();
  const connectionRegistry = createLobbyConnectionRegistry();
  const receiptStore = createLobbyCommandReceiptStore();
  const roomCodeAllocator = createRoomCodeAllocator(repository);
  const createService = createCreateRoomService({
    repository,
    roomCodeAllocator,
    connectionRegistry,
    receiptStore,
    generateIdentifier: randomUUID,
  });
  const joinService = createJoinRoomService({
    repository,
    connectionRegistry,
    receiptStore,
    generateIdentifier: randomUUID,
  });
  const setSeatService = createSetSeatService({
    repository,
    connectionRegistry,
    receiptStore,
  });
  const snapshotDeliveryPlanner = createLobbySnapshotDeliveryPlanner({
    repository,
    connectionRegistry,
  });

  return {
    createRoom: (socketId, rawCommand) =>
      createService.create(socketId, rawCommand),
    joinRoom: (socketId, rawCommand) => joinService.join(socketId, rawCommand),
    setSeat: (socketId, rawCommand) =>
      setSeatService.setSeat(socketId, rawCommand),
    prepareLobbySnapshotDeliveries: (roomId) =>
      snapshotDeliveryPlanner.prepare(roomId),
  };
}
