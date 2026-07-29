import { randomUUID } from 'node:crypto';

import {
  deriveDisplayNameKey,
  parseCommandId,
  parseJoinRoomCommand,
  parseJoinRoomErrorAcknowledgement,
  parseJoinRoomSuccess,
  parsePlayerId,
  type CommandId,
  type JoinRoomAcknowledgement,
  type JoinRoomCommand,
  type JoinRoomErrorAcknowledgement,
  type JoinRoomErrorCode,
  type PlayerId,
} from '@guandan/protocol';

import type { LobbyCommandReceiptStore } from './command-receipts.js';
import type {
  LobbyConnectionBinding,
  LobbyConnectionRegistry,
} from './connection-registry.js';
import type { LobbyIdentifierGenerator } from './create-room.js';
import {
  LobbyInvariantError,
  assertValidLobbyRoomState,
} from './invariants.js';
import type { LobbyPlayerState, LobbyRoomState } from './model.js';
import type { LobbyRepository, ReplaceLobbyRoomResult } from './repository.js';
import { projectLobbySnapshot } from './snapshot.js';

export interface JoinRoomServiceDependencies {
  repository: LobbyRepository;
  connectionRegistry: LobbyConnectionRegistry;
  receiptStore: LobbyCommandReceiptStore;
  generateIdentifier?: LobbyIdentifierGenerator;
  validateRoom?: (room: LobbyRoomState) => void;
  projectSnapshot?: typeof projectLobbySnapshot;
  parseSuccess?: typeof parseJoinRoomSuccess;
}

export interface JoinRoomService {
  join(socketId: string, rawCommand: unknown): JoinRoomAcknowledgement;
}

export function createJoinRoomService(
  dependencies: JoinRoomServiceDependencies,
): JoinRoomService {
  const generateIdentifier = dependencies.generateIdentifier ?? randomUUID;
  const validateRoom = dependencies.validateRoom ?? assertValidLobbyRoomState;
  const projectSnapshot = dependencies.projectSnapshot ?? projectLobbySnapshot;
  const parseSuccess = dependencies.parseSuccess ?? parseJoinRoomSuccess;

  return {
    join(socketId, rawCommand): JoinRoomAcknowledgement {
      const command = parseJoinRoomCommand(rawCommand);
      if (command === undefined) {
        return createError(
          'INVALID_PAYLOAD',
          'Invalid join-room command payload',
          getValidCommandId(rawCommand),
        );
      }

      const existingReceipt = dependencies.receiptStore.get(command.commandId);
      if (existingReceipt !== undefined) {
        return existingReceipt.commandKind === 'join-room' &&
          existingReceipt.socketId === socketId &&
          joinCommandsEqual(existingReceipt.command, command)
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

      const currentRoom = dependencies.repository.getByCode(command.roomCode);
      if (currentRoom === undefined) {
        return createError(
          'ROOM_NOT_FOUND',
          'Room was not found',
          command.commandId,
        );
      }
      if (currentRoom.settings.hasPassword) {
        return createError(
          'INTERNAL_ERROR',
          'Room cannot be joined with this command',
          command.commandId,
        );
      }
      if (currentRoom.players.length >= 4) {
        return createError('ROOM_FULL', 'Room is full', command.commandId);
      }

      const displayNameKey = deriveDisplayNameKey(command.displayName);
      if (displayNameKey === undefined) {
        return createError(
          'INVALID_LOBBY_STATE',
          'Constructed lobby state is invalid',
          command.commandId,
        );
      }
      if (
        currentRoom.players.some(
          (player) => player.displayNameKey === displayNameKey,
        )
      ) {
        return createError(
          'NAME_TAKEN',
          'Display name is already in use',
          command.commandId,
        );
      }

      let playerId: PlayerId;
      let joinOrder: number;
      let nextRevision: number;
      try {
        playerId = requirePlayerId(generateIdentifier());
        if (
          currentRoom.players.some((player) => player.playerId === playerId)
        ) {
          throw new Error('Generated player ID is already in use');
        }
        joinOrder = deriveNextJoinOrder(currentRoom.players);
        nextRevision = incrementSafely(currentRoom.revision);
      } catch {
        return createError(
          'INTERNAL_ERROR',
          'Room join failed',
          command.commandId,
        );
      }

      const nextRoom: LobbyRoomState = {
        ...currentRoom,
        revision: nextRevision,
        players: [
          ...currentRoom.players,
          {
            playerId,
            displayName: command.displayName,
            displayNameKey,
            joinOrder,
            seat: null,
            ready: false,
            connectionStatus: 'connected',
          },
        ],
      };

      let replacement: ReplaceLobbyRoomResult;
      try {
        validateRoom(nextRoom);
        replacement = dependencies.repository.replaceRoom({
          roomId: currentRoom.roomId,
          expectedRevision: currentRoom.revision,
          nextRoom,
        });
      } catch (error: unknown) {
        return error instanceof LobbyInvariantError
          ? createError(
              'INVALID_LOBBY_STATE',
              'Constructed lobby state is invalid',
              command.commandId,
            )
          : createError(
              'INTERNAL_ERROR',
              'Room join failed',
              command.commandId,
            );
      }

      const binding: LobbyConnectionBinding = {
        roomId: currentRoom.roomId,
        playerId,
      };
      let bindingAttempted = false;
      try {
        bindingAttempted = true;
        dependencies.connectionRegistry.bind(socketId, binding);
        const snapshot = projectSnapshot(replacement.storedRoom, playerId);
        const success = parseSuccess({
          status: 'ok',
          commandId: command.commandId,
          roomRevision: nextRevision,
          snapshot,
        });
        if (success === undefined) {
          throw new LobbyInvariantError('Join-room success is invalid');
        }
        const receipt = dependencies.receiptStore.insert({
          commandKind: 'join-room',
          socketId,
          command,
          success,
        });
        if (receipt.commandKind !== 'join-room') {
          throw new Error('Join-room receipt kind is invalid');
        }
        return receipt.success;
      } catch (error: unknown) {
        const cleanupSucceeded = rollback(
          dependencies,
          socketId,
          bindingAttempted ? binding : undefined,
          replacement,
        );
        if (!cleanupSucceeded) {
          return createError(
            'INTERNAL_ERROR',
            'Room join failed',
            command.commandId,
          );
        }
        return error instanceof LobbyInvariantError
          ? createError(
              'INVALID_LOBBY_STATE',
              'Constructed lobby state is invalid',
              command.commandId,
            )
          : createError(
              'INTERNAL_ERROR',
              'Room join failed',
              command.commandId,
            );
      }
    },
  };
}

function deriveNextJoinOrder(players: readonly LobbyPlayerState[]): number {
  const maximum = Math.max(...players.map((player) => player.joinOrder));
  return incrementSafely(maximum);
}

function incrementSafely(value: number): number {
  if (!Number.isSafeInteger(value) || value === Number.MAX_SAFE_INTEGER) {
    throw new Error('Safe integer overflow');
  }
  return value + 1;
}

function rollback(
  dependencies: JoinRoomServiceDependencies,
  socketId: string,
  binding: LobbyConnectionBinding | undefined,
  replacement: ReplaceLobbyRoomResult,
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
  try {
    dependencies.repository.restoreRoomForRollback({
      roomId: replacement.previousRoom.roomId,
      expectedCurrentRevision: replacement.storedRoom.revision,
      previousRoom: replacement.previousRoom,
    });
  } catch {
    succeeded = false;
  }
  return succeeded;
}

function joinCommandsEqual(
  left: JoinRoomCommand,
  right: JoinRoomCommand,
): boolean {
  return (
    left.commandId === right.commandId &&
    left.roomCode === right.roomCode &&
    left.displayName === right.displayName
  );
}

function createError(
  code: JoinRoomErrorCode,
  message: string,
  commandId?: CommandId,
): JoinRoomErrorAcknowledgement {
  const error = parseJoinRoomErrorAcknowledgement({
    status: 'error',
    code,
    message,
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (error === undefined) {
    throw new Error('Join-room error acknowledgement is invalid');
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

function requirePlayerId(value: string): PlayerId {
  const playerId = parsePlayerId(value);
  if (playerId === undefined) {
    throw new Error('Identifier generator returned an invalid player ID');
  }
  return playerId;
}
