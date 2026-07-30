import type {
  CommandId,
  CreateRoomCommand,
  CreateRoomSuccess,
  JoinRoomCommand,
  JoinRoomSuccess,
  SetSeatCommand,
  SetSeatSuccess,
} from '@guandan/protocol';

export interface CreateRoomCommandReceipt {
  commandKind: 'create-room';
  socketId: string;
  command: CreateRoomCommand;
  success: CreateRoomSuccess;
}

export interface JoinRoomCommandReceipt {
  commandKind: 'join-room';
  socketId: string;
  command: JoinRoomCommand;
  success: JoinRoomSuccess;
}

export interface SetSeatCommandReceipt {
  commandKind: 'set-seat';
  socketId: string;
  command: SetSeatCommand;
  success: SetSeatSuccess;
}

export type LobbyCommandReceipt =
  CreateRoomCommandReceipt | JoinRoomCommandReceipt | SetSeatCommandReceipt;

export interface LobbyCommandReceiptStore {
  get(commandId: CommandId): LobbyCommandReceipt | undefined;
  insert(receipt: LobbyCommandReceipt): LobbyCommandReceipt;
}

export class LobbyCommandReceiptConflictError extends Error {
  constructor() {
    super('Lobby command receipt already exists');
    this.name = 'LobbyCommandReceiptConflictError';
  }
}

export function createLobbyCommandReceiptStore(): LobbyCommandReceiptStore {
  const receipts = new Map<CommandId, LobbyCommandReceipt>();

  return {
    get(commandId): LobbyCommandReceipt | undefined {
      return receipts.get(commandId);
    },
    insert(receipt): LobbyCommandReceipt {
      if (receipts.has(receipt.command.commandId)) {
        throw new LobbyCommandReceiptConflictError();
      }
      const storedReceipt = freezeReceipt(receipt);
      receipts.set(receipt.command.commandId, storedReceipt);
      return storedReceipt;
    },
  };
}

function freezeReceipt(receipt: LobbyCommandReceipt): LobbyCommandReceipt {
  if (receipt.commandKind === 'create-room') {
    return Object.freeze({
      commandKind: 'create-room',
      socketId: receipt.socketId,
      command: Object.freeze({
        ...receipt.command,
        settings: Object.freeze({ ...receipt.command.settings }),
      }),
      success: freezeSuccess(receipt.success),
    });
  }

  return Object.freeze({
    commandKind: receipt.commandKind,
    socketId: receipt.socketId,
    command: Object.freeze({ ...receipt.command }),
    success: freezeSuccess(receipt.success),
  }) as LobbyCommandReceipt;
}

function freezeSuccess<
  T extends CreateRoomSuccess | JoinRoomSuccess | SetSeatSuccess,
>(success: T): T {
  const snapshot = success.snapshot;
  return Object.freeze({
    ...success,
    snapshot: Object.freeze({
      ...snapshot,
      settings: Object.freeze({ ...snapshot.settings }),
      players: Object.freeze(
        snapshot.players.map((player) => Object.freeze({ ...player })),
      ),
      startEligibility: Object.freeze({
        ...snapshot.startEligibility,
        blockers: Object.freeze([...snapshot.startEligibility.blockers]),
      }),
      capabilities: Object.freeze({ ...snapshot.capabilities }),
    }),
  }) as unknown as T;
}
