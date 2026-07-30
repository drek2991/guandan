import {
  parseCommandId,
  parseSetSeatCommand,
  parseSetSeatErrorAcknowledgement,
  parseSetSeatSuccess,
  type CommandId,
  type RoomRevision,
  type SetSeatAcknowledgement,
  type SetSeatCommand,
  type SetSeatErrorAcknowledgement,
  type SetSeatErrorCode,
  type SetSeatSuccess,
} from '@guandan/protocol';

import type { LobbyCommandReceiptStore } from './command-receipts.js';
import type { LobbyConnectionRegistry } from './connection-registry.js';
import {
  LobbyInvariantError,
  assertValidLobbyRoomState,
} from './invariants.js';
import type { LobbyRoomState } from './model.js';
import type { LobbyRepository, ReplaceLobbyRoomResult } from './repository.js';
import { projectLobbySnapshot } from './snapshot.js';

export interface SetSeatServiceDependencies {
  repository: LobbyRepository;
  connectionRegistry: LobbyConnectionRegistry;
  receiptStore: LobbyCommandReceiptStore;
  validateRoom?: (room: LobbyRoomState) => void;
  projectSnapshot?: typeof projectLobbySnapshot;
  parseSuccess?: typeof parseSetSeatSuccess;
}

export interface SetSeatService {
  setSeat(socketId: string, rawCommand: unknown): SetSeatAcknowledgement;
}

export function createSetSeatService(
  dependencies: SetSeatServiceDependencies,
): SetSeatService {
  const validateRoom = dependencies.validateRoom ?? assertValidLobbyRoomState;
  const projectSnapshot = dependencies.projectSnapshot ?? projectLobbySnapshot;
  const parseSuccess = dependencies.parseSuccess ?? parseSetSeatSuccess;

  return {
    setSeat(socketId, rawCommand): SetSeatAcknowledgement {
      const command = parseSetSeatCommand(rawCommand);
      if (command === undefined) {
        return createError(
          'INVALID_PAYLOAD',
          'Invalid set-seat command payload',
          getValidCommandId(rawCommand),
        );
      }

      const existingReceipt = dependencies.receiptStore.get(command.commandId);
      if (existingReceipt !== undefined) {
        return existingReceipt.commandKind === 'set-seat' &&
          existingReceipt.socketId === socketId &&
          setSeatCommandsEqual(existingReceipt.command, command)
          ? existingReceipt.success
          : createError(
              'COMMAND_ID_CONFLICT',
              'Command ID conflicts with an existing command',
              command.commandId,
            );
      }

      const binding = dependencies.connectionRegistry.get(socketId);
      if (binding === undefined) {
        return createError(
          'NOT_ROOM_MEMBER',
          'Connection is not bound to a lobby',
          command.commandId,
        );
      }

      const currentRoom = dependencies.repository.getById(binding.roomId);
      if (currentRoom === undefined) {
        return createError(
          'INTERNAL_ERROR',
          'Seat selection failed',
          command.commandId,
        );
      }

      try {
        validateRoom(currentRoom);
      } catch {
        return createError(
          'INTERNAL_ERROR',
          'Seat selection failed',
          command.commandId,
        );
      }

      const matchingPlayers = currentRoom.players.filter(
        (player) => player.playerId === binding.playerId,
      );
      const actingPlayer = matchingPlayers[0];
      if (matchingPlayers.length !== 1 || actingPlayer === undefined) {
        return createError(
          'INTERNAL_ERROR',
          'Seat selection failed',
          command.commandId,
        );
      }

      if (command.knownRevision !== currentRoom.revision) {
        return createError(
          'STALE_REVISION',
          'Room revision is stale',
          command.commandId,
          currentRoom.revision,
        );
      }

      if (actingPlayer.seat === command.seat) {
        return completeNoOp(
          dependencies,
          socketId,
          command,
          currentRoom,
          actingPlayer.playerId,
          projectSnapshot,
          parseSuccess,
        );
      }

      if (
        command.seat !== null &&
        currentRoom.players.some(
          (player) =>
            player.playerId !== actingPlayer.playerId &&
            player.seat === command.seat,
        )
      ) {
        return createError(
          'SEAT_TAKEN',
          'Requested seat is already occupied',
          command.commandId,
        );
      }

      const nextRevision = incrementSafely(currentRoom.revision);
      if (nextRevision === undefined) {
        return createError(
          'INTERNAL_ERROR',
          'Seat selection failed',
          command.commandId,
        );
      }
      const nextRoom: LobbyRoomState = {
        ...currentRoom,
        revision: nextRevision,
        players: currentRoom.players.map((player) =>
          player.playerId === actingPlayer.playerId
            ? { ...player, seat: command.seat, ready: false }
            : player,
        ),
      };

      try {
        validateRoom(nextRoom);
      } catch (error: unknown) {
        return error instanceof LobbyInvariantError
          ? createError(
              'INVALID_LOBBY_STATE',
              'Constructed lobby state is invalid',
              command.commandId,
            )
          : createError(
              'INTERNAL_ERROR',
              'Seat selection failed',
              command.commandId,
            );
      }

      let replacement: ReplaceLobbyRoomResult;
      try {
        replacement = dependencies.repository.replaceRoomForSeatSelection({
          roomId: currentRoom.roomId,
          expectedRevision: currentRoom.revision,
          actingPlayerId: actingPlayer.playerId,
          expectedCurrentSeat: actingPlayer.seat,
          requestedNextSeat: command.seat,
          nextRoom,
        });
      } catch {
        return createError(
          'INTERNAL_ERROR',
          'Seat selection failed',
          command.commandId,
        );
      }

      try {
        const success = createAndValidateSuccess(
          command,
          replacement.storedRoom,
          actingPlayer.playerId,
          true,
          projectSnapshot,
          parseSuccess,
        );
        const receipt = dependencies.receiptStore.insert({
          commandKind: 'set-seat',
          socketId,
          command,
          success,
        });
        if (receipt.commandKind !== 'set-seat') {
          throw new Error('Set-seat receipt kind is invalid');
        }
        return receipt.success;
      } catch (error: unknown) {
        const rollbackSucceeded = rollback(dependencies, replacement);
        if (!rollbackSucceeded) {
          return createError(
            'INTERNAL_ERROR',
            'Seat selection failed',
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
              'Seat selection failed',
              command.commandId,
            );
      }
    },
  };
}

function completeNoOp(
  dependencies: SetSeatServiceDependencies,
  socketId: string,
  command: SetSeatCommand,
  room: LobbyRoomState,
  actingPlayerId: LobbyRoomState['players'][number]['playerId'],
  projectSnapshot: typeof projectLobbySnapshot,
  parseSuccess: typeof parseSetSeatSuccess,
): SetSeatAcknowledgement {
  try {
    const success = createAndValidateSuccess(
      command,
      room,
      actingPlayerId,
      false,
      projectSnapshot,
      parseSuccess,
    );
    const receipt = dependencies.receiptStore.insert({
      commandKind: 'set-seat',
      socketId,
      command,
      success,
    });
    if (receipt.commandKind !== 'set-seat') {
      throw new Error('Set-seat receipt kind is invalid');
    }
    return receipt.success;
  } catch (error: unknown) {
    return error instanceof LobbyInvariantError
      ? createError(
          'INVALID_LOBBY_STATE',
          'Constructed lobby state is invalid',
          command.commandId,
        )
      : createError(
          'INTERNAL_ERROR',
          'Seat selection failed',
          command.commandId,
        );
  }
}

function createAndValidateSuccess(
  command: SetSeatCommand,
  room: LobbyRoomState,
  actingPlayerId: LobbyRoomState['players'][number]['playerId'],
  seatChanged: boolean,
  projectSnapshot: typeof projectLobbySnapshot,
  parseSuccess: typeof parseSetSeatSuccess,
): SetSeatSuccess {
  try {
    const snapshot = projectSnapshot(room, actingPlayerId);
    const success = parseSuccess({
      status: 'ok',
      commandId: command.commandId,
      roomRevision: room.revision,
      snapshot,
    });
    const self = success?.snapshot.players.find(
      (player) => player.playerId === actingPlayerId,
    );
    if (
      success === undefined ||
      self === undefined ||
      self.seat !== command.seat ||
      (seatChanged && self.ready)
    ) {
      throw new LobbyInvariantError('Set-seat success is invalid');
    }
    return success;
  } catch (error: unknown) {
    throw error instanceof LobbyInvariantError
      ? error
      : new LobbyInvariantError('Set-seat success is invalid');
  }
}

function rollback(
  dependencies: SetSeatServiceDependencies,
  replacement: ReplaceLobbyRoomResult,
): boolean {
  try {
    dependencies.repository.restoreRoomForSeatSelectionRollback({
      roomId: replacement.previousRoom.roomId,
      expectedCurrentRevision: replacement.storedRoom.revision,
      previousRoom: replacement.previousRoom,
    });
    return true;
  } catch {
    return false;
  }
}

function incrementSafely(value: number): number | undefined {
  return Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER
    ? value + 1
    : undefined;
}

function setSeatCommandsEqual(
  left: SetSeatCommand,
  right: SetSeatCommand,
): boolean {
  return (
    left.commandId === right.commandId &&
    left.knownRevision === right.knownRevision &&
    left.seat === right.seat
  );
}

function createError(
  code: SetSeatErrorCode,
  message: string,
  commandId?: CommandId,
  currentRevision?: RoomRevision,
): SetSeatErrorAcknowledgement {
  const error = parseSetSeatErrorAcknowledgement({
    status: 'error',
    code,
    message,
    ...(commandId === undefined ? {} : { commandId }),
    ...(currentRevision === undefined ? {} : { currentRevision }),
  });
  if (error === undefined) {
    throw new Error('Set-seat error acknowledgement is invalid');
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
