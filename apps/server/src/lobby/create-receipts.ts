import type {
  CommandId,
  CreateRoomCommand,
  CreateRoomSuccess,
} from '@guandan/protocol';

export interface CreateRoomReceipt {
  socketId: string;
  command: CreateRoomCommand;
  success: CreateRoomSuccess;
}

export interface CreateRoomReceiptStore {
  get(commandId: CommandId): CreateRoomReceipt | undefined;
  insert(receipt: CreateRoomReceipt): CreateRoomReceipt;
}

export class CreateRoomReceiptConflictError extends Error {
  constructor() {
    super('Create-room receipt already exists');
    this.name = 'CreateRoomReceiptConflictError';
  }
}

export function createCreateRoomReceiptStore(): CreateRoomReceiptStore {
  const receipts = new Map<CommandId, CreateRoomReceipt>();

  return {
    get(commandId): CreateRoomReceipt | undefined {
      return receipts.get(commandId);
    },
    insert(receipt): CreateRoomReceipt {
      if (receipts.has(receipt.command.commandId)) {
        throw new CreateRoomReceiptConflictError();
      }
      const storedReceipt = freezeReceipt(receipt);
      receipts.set(receipt.command.commandId, storedReceipt);
      return storedReceipt;
    },
  };
}

function freezeReceipt(receipt: CreateRoomReceipt): CreateRoomReceipt {
  const command = Object.freeze({
    ...receipt.command,
    settings: Object.freeze({ ...receipt.command.settings }),
  });
  const snapshot = receipt.success.snapshot;
  const success = Object.freeze({
    ...receipt.success,
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
  }) as CreateRoomSuccess;
  return Object.freeze({
    socketId: receipt.socketId,
    command,
    success,
  });
}
