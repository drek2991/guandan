import { randomUUID } from 'node:crypto';

import {
  INITIAL_LOBBY_REVISION,
  deriveDisplayNameKey,
  parseCommandId,
  parseCreateRoomCommand,
  parseCreateRoomErrorAcknowledgement,
  parseCreateRoomSuccess,
  parsePlayerId,
  parseRoomId,
  type CommandId,
  type CreateRoomAcknowledgement,
  type CreateRoomCommand,
  type CreateRoomErrorAcknowledgement,
  type CreateRoomErrorCode,
  type CreateRoomSuccess,
  type PlayerId,
  type RoomCode,
  type RoomId,
} from '@guandan/protocol';

import {
  LobbyConnectionAlreadyBoundError,
  type LobbyConnectionBinding,
  type LobbyConnectionRegistry,
} from './connection-registry.js';
import type { LobbyCommandReceiptStore } from './command-receipts.js';
import {
  LobbyInvariantError,
  assertValidLobbyRoomState,
} from './invariants.js';
import type { LobbyRoomState } from './model.js';
import {
  LobbyRepositoryInsertError,
  type LobbyRepository,
} from './repository.js';
import type { RoomCodeAllocator } from './room-code.js';
import { projectLobbySnapshot } from './snapshot.js';

export type LobbyIdentifierGenerator = () => string;

export interface CreateRoomServiceDependencies {
  repository: LobbyRepository;
  roomCodeAllocator: RoomCodeAllocator;
  connectionRegistry: LobbyConnectionRegistry;
  receiptStore: LobbyCommandReceiptStore;
  generateIdentifier?: LobbyIdentifierGenerator;
  validateRoom?: (room: LobbyRoomState) => void;
  projectSnapshot?: typeof projectLobbySnapshot;
}

export interface CreateRoomService {
  create(socketId: string, rawCommand: unknown): CreateRoomAcknowledgement;
}

export function createCreateRoomService(
  dependencies: CreateRoomServiceDependencies,
): CreateRoomService {
  const generateIdentifier = dependencies.generateIdentifier ?? randomUUID;
  const validateRoom = dependencies.validateRoom ?? assertValidLobbyRoomState;
  const projectSnapshot = dependencies.projectSnapshot ?? projectLobbySnapshot;

  return {
    create(socketId, rawCommand): CreateRoomAcknowledgement {
      const command = parseCreateRoomCommand(rawCommand);
      if (command === undefined) {
        return createError(
          'INVALID_PAYLOAD',
          'Invalid create-room command payload',
          getValidCommandId(rawCommand),
        );
      }

      const existingReceipt = dependencies.receiptStore.get(command.commandId);
      if (existingReceipt !== undefined) {
        return existingReceipt.commandKind === 'create-room' &&
          existingReceipt.socketId === socketId &&
          createCommandsEqual(existingReceipt.command, command)
          ? existingReceipt.success
          : createError(
              'COMMAND_ID_CONFLICT',
              'Command ID conflicts with an existing command',
              command.commandId,
            );
      }

      if (dependencies.connectionRegistry.get(socketId) !== undefined) {
        return createError(
          'ALREADY_IN_ROOM',
          'Connection is already bound to a lobby',
          command.commandId,
        );
      }

      let roomId: RoomId;
      let playerId: PlayerId;
      try {
        roomId = requireRoomId(generateIdentifier());
        playerId = requirePlayerId(generateIdentifier());
      } catch {
        return createError(
          'INTERNAL_ERROR',
          'Room creation failed',
          command.commandId,
        );
      }

      let storedRoom: LobbyRoomState | undefined;
      let binding: LobbyConnectionBinding | undefined;
      try {
        try {
          storedRoom = dependencies.roomCodeAllocator.allocate((roomCode) => {
            const room = constructRoom(command, roomId, playerId, roomCode);
            validateRoom(room);
            return dependencies.repository.insert(room);
          });
        } catch (error: unknown) {
          return mapCreateFailure(error, command.commandId);
        }
        if (storedRoom === undefined) {
          return createError(
            'ROOM_CODE_UNAVAILABLE',
            'No room code is currently available',
            command.commandId,
          );
        }

        binding = { roomId, playerId };
        dependencies.connectionRegistry.bind(socketId, binding);
        const snapshot = projectSnapshot(storedRoom, playerId);
        const success = parseCreateRoomSuccess({
          status: 'ok',
          commandId: command.commandId,
          roomRevision: INITIAL_LOBBY_REVISION,
          snapshot,
        });
        if (success === undefined) {
          throw new LobbyInvariantError('Create-room success is invalid');
        }

        const receipt = dependencies.receiptStore.insert({
          commandKind: 'create-room',
          socketId,
          command,
          success,
        });
        if (receipt.commandKind !== 'create-room') {
          throw new Error('Create-room receipt kind is invalid');
        }
        return receipt.success;
      } catch (error: unknown) {
        const cleanupSucceeded = rollback(
          dependencies,
          socketId,
          binding,
          storedRoom,
        );
        if (!cleanupSucceeded) {
          return createError(
            'INTERNAL_ERROR',
            'Room creation failed',
            command.commandId,
          );
        }
        return mapCreateFailure(error, command.commandId);
      }
    },
  };
}

function constructRoom(
  command: CreateRoomCommand,
  roomId: RoomId,
  playerId: PlayerId,
  roomCode: RoomCode,
): LobbyRoomState {
  const displayNameKey = deriveDisplayNameKey(command.displayName);
  if (displayNameKey === undefined) {
    throw new LobbyInvariantError('Display-name key derivation failed');
  }

  return {
    roomId,
    roomCode,
    revision: INITIAL_LOBBY_REVISION,
    phase: 'lobby',
    hostPlayerId: playerId,
    settings: {
      ...command.settings,
      hasPassword: false,
    },
    players: [
      {
        playerId,
        displayName: command.displayName,
        displayNameKey,
        joinOrder: 0,
        seat: null,
        ready: false,
        connectionStatus: 'connected',
      },
    ],
  };
}

function rollback(
  dependencies: CreateRoomServiceDependencies,
  socketId: string,
  binding: LobbyConnectionBinding | undefined,
  storedRoom: LobbyRoomState | undefined,
): boolean {
  let succeeded = true;
  if (binding !== undefined) {
    try {
      succeeded =
        dependencies.connectionRegistry.unbindForRollback(socketId, binding) &&
        succeeded;
    } catch {
      succeeded = false;
    }
  }
  if (storedRoom !== undefined) {
    try {
      succeeded =
        dependencies.repository.deleteForRollback(storedRoom.roomId) &&
        succeeded;
    } catch {
      succeeded = false;
    }
  }
  return succeeded;
}

function mapCreateFailure(
  error: unknown,
  commandId: CommandId,
): CreateRoomErrorAcknowledgement {
  if (error instanceof LobbyInvariantError) {
    return createError(
      'INVALID_LOBBY_STATE',
      'Constructed lobby state is invalid',
      commandId,
    );
  }
  if (error instanceof LobbyConnectionAlreadyBoundError) {
    return createError(
      'ALREADY_IN_ROOM',
      'Connection is already bound to a lobby',
      commandId,
    );
  }
  if (
    error instanceof LobbyRepositoryInsertError &&
    error.failure === 'duplicate-room-code'
  ) {
    return createError(
      'ROOM_CODE_UNAVAILABLE',
      'No room code is currently available',
      commandId,
    );
  }
  return createError('INTERNAL_ERROR', 'Room creation failed', commandId);
}

function createError(
  code: CreateRoomErrorCode,
  message: string,
  commandId?: CommandId,
): CreateRoomErrorAcknowledgement {
  const error = parseCreateRoomErrorAcknowledgement({
    status: 'error',
    code,
    message,
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (error === undefined) {
    throw new Error('Create-room error acknowledgement is invalid');
  }
  return error;
}

function getValidCommandId(value: unknown): CommandId | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'commandId')
  ) {
    return undefined;
  }
  return parseCommandId((value as Record<string, unknown>).commandId);
}

function createCommandsEqual(
  left: CreateRoomCommand,
  right: CreateRoomCommand,
): boolean {
  return (
    left.commandId === right.commandId &&
    left.displayName === right.displayName &&
    left.settings.startingLevel === right.settings.startingLevel &&
    left.settings.turnTimer === right.settings.turnTimer
  );
}

function requireRoomId(value: string): RoomId {
  const roomId = parseRoomId(value);
  if (roomId === undefined) {
    throw new Error('Identifier generator returned an invalid room ID');
  }
  return roomId;
}

function requirePlayerId(value: string): PlayerId {
  const playerId = parsePlayerId(value);
  if (playerId === undefined) {
    throw new Error('Identifier generator returned an invalid player ID');
  }
  return playerId;
}

export function isCreateRoomSuccess(
  value: CreateRoomAcknowledgement,
): value is CreateRoomSuccess {
  return value.status === 'ok';
}
