import {
  LOBBY_SNAPSHOT_EVENT,
  parseCommandId,
  type CommandId,
  type LobbyMutationSuccess,
  type LobbySnapshotV1,
  type RoomId,
} from '@guandan/protocol';

import type { LobbySnapshotDeliveryPlan } from './snapshot-delivery.js';

export type LobbyCommandKind = 'create-room' | 'join-room';

export interface LobbyTransportSocket {
  id: string;
  connected: boolean;
  join(roomId: RoomId): void | Promise<void>;
  emit(event: typeof LOBBY_SNAPSHOT_EVENT, snapshot: LobbySnapshotV1): unknown;
}

export interface LobbyTransportLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface LobbyCommandTransportCompletion<Acknowledgement> {
  acknowledgement: Acknowledgement;
  afterAcknowledgement?: () => void;
}

export interface LobbyCommandTransportDependencies<
  Acknowledgement,
  Success extends LobbyMutationSuccess,
> {
  commandKind: LobbyCommandKind;
  initiatingSocket: LobbyTransportSocket;
  getActiveSocket(socketId: string): LobbyTransportSocket | undefined;
  prepareDeliveries(roomId: RoomId): LobbySnapshotDeliveryPlan;
  parseSuccess(value: unknown): Success | undefined;
  createInternalError(commandId: CommandId): Acknowledgement;
  logger: LobbyTransportLogger;
}

export async function completeLobbyCommandTransport<
  Acknowledgement,
  Success extends LobbyMutationSuccess,
>(
  acknowledgement: Acknowledgement,
  dependencies: LobbyCommandTransportDependencies<Acknowledgement, Success>,
): Promise<LobbyCommandTransportCompletion<Acknowledgement>> {
  if (!isSuccessCandidate(acknowledgement)) {
    return { acknowledgement };
  }

  const success = dependencies.parseSuccess(acknowledgement);
  if (success === undefined) {
    const commandId = parseCommandId(acknowledgement.commandId);
    if (commandId === undefined) {
      dependencies.logger.error(
        `Lobby transport kind=${dependencies.commandKind} command=unknown status=error phase=success-validation`,
      );
      return { acknowledgement };
    }
    return transportFailure(dependencies, commandId, 'success-validation');
  }
  const commandId = success.commandId;

  let plan: LobbySnapshotDeliveryPlan;
  try {
    plan = dependencies.prepareDeliveries(success.snapshot.roomId);
  } catch {
    return transportFailure(dependencies, commandId, 'planning');
  }

  const initiatingDeliveries = plan.deliveries.filter(
    (delivery) =>
      delivery.socketId === dependencies.initiatingSocket.id &&
      delivery.playerId === success.snapshot.selfPlayerId,
  );
  if (
    success.snapshot.roomId !== plan.roomId ||
    initiatingDeliveries.length !== 1 ||
    plan.revision < success.roomRevision
  ) {
    return transportFailure(dependencies, commandId, 'plan-validation');
  }

  if (!isActiveInitiator(dependencies)) {
    return transportFailure(dependencies, commandId, 'initiator-availability');
  }

  try {
    await dependencies.initiatingSocket.join(plan.roomId);
  } catch {
    return transportFailure(dependencies, commandId, 'channel-join');
  }

  const initiatingDelivery = initiatingDeliveries[0]!;
  const otherDeliveries = plan.deliveries.filter(
    (delivery) => delivery !== initiatingDelivery,
  );

  if (plan.revision === success.roomRevision) {
    if (!emitInitiatingDelivery(dependencies, initiatingDelivery.snapshot)) {
      return transportFailure(dependencies, commandId, 'initiator-emission');
    }
    const counts = emitOtherDeliveries(dependencies, otherDeliveries);
    logSuccess(dependencies, commandId, plan, counts, 'before-acknowledgement');
    return { acknowledgement };
  }

  return {
    acknowledgement,
    afterAcknowledgement: () => {
      const initiatingQueued = emitInitiatingDelivery(
        dependencies,
        initiatingDelivery.snapshot,
      );
      const counts = emitOtherDeliveries(dependencies, otherDeliveries);
      if (!initiatingQueued) {
        dependencies.logger.error(
          formatEvidence(
            dependencies.commandKind,
            commandId,
            plan,
            { ...counts, failed: counts.failed + 1 },
            'error',
            'initiator-emission-after-acknowledgement',
            false,
          ),
        );
        return;
      }
      logSuccess(
        dependencies,
        commandId,
        plan,
        counts,
        'after-stale-acknowledgement',
      );
    },
  };
}

function emitInitiatingDelivery<
  Acknowledgement,
  Success extends LobbyMutationSuccess,
>(
  dependencies: LobbyCommandTransportDependencies<Acknowledgement, Success>,
  snapshot: LobbySnapshotV1,
): boolean {
  if (!isActiveInitiator(dependencies)) {
    return false;
  }
  try {
    dependencies.initiatingSocket.emit(LOBBY_SNAPSHOT_EVENT, snapshot);
    return true;
  } catch {
    return false;
  }
}

function emitOtherDeliveries<
  Acknowledgement,
  Success extends LobbyMutationSuccess,
>(
  dependencies: LobbyCommandTransportDependencies<Acknowledgement, Success>,
  deliveries: readonly LobbySnapshotDeliveryPlan['deliveries'][number][],
): { emitted: number; skipped: number; failed: number } {
  let emitted = 0;
  let skipped = 0;
  let failed = 0;

  for (const delivery of deliveries) {
    const socket = dependencies.getActiveSocket(delivery.socketId);
    if (socket === undefined || !socket.connected) {
      skipped += 1;
      continue;
    }
    try {
      socket.emit(LOBBY_SNAPSHOT_EVENT, delivery.snapshot);
      emitted += 1;
    } catch {
      failed += 1;
    }
  }

  return { emitted, skipped, failed };
}

function isActiveInitiator<
  Acknowledgement,
  Success extends LobbyMutationSuccess,
>(
  dependencies: LobbyCommandTransportDependencies<Acknowledgement, Success>,
): boolean {
  return (
    dependencies.initiatingSocket.connected &&
    dependencies.getActiveSocket(dependencies.initiatingSocket.id) ===
      dependencies.initiatingSocket
  );
}

function transportFailure<
  Acknowledgement,
  Success extends LobbyMutationSuccess,
>(
  dependencies: LobbyCommandTransportDependencies<Acknowledgement, Success>,
  commandId: CommandId,
  phase: string,
): LobbyCommandTransportCompletion<Acknowledgement> {
  dependencies.logger.error(
    `Lobby transport kind=${dependencies.commandKind} command=${commandId} status=error phase=${phase}`,
  );
  return { acknowledgement: dependencies.createInternalError(commandId) };
}

function logSuccess<Acknowledgement, Success extends LobbyMutationSuccess>(
  dependencies: LobbyCommandTransportDependencies<Acknowledgement, Success>,
  commandId: CommandId,
  plan: LobbySnapshotDeliveryPlan,
  counts: { emitted: number; skipped: number; failed: number },
  phase: string,
): void {
  dependencies.logger.info(
    formatEvidence(
      dependencies.commandKind,
      commandId,
      plan,
      counts,
      'ok',
      phase,
    ),
  );
}

function formatEvidence(
  commandKind: LobbyCommandKind,
  commandId: CommandId,
  plan: LobbySnapshotDeliveryPlan,
  counts: { emitted: number; skipped: number; failed: number },
  status: 'ok' | 'error',
  phase: string,
  initiatingQueued = true,
): string {
  const emitted = counts.emitted + (initiatingQueued ? 1 : 0);
  return `Lobby transport kind=${commandKind} command=${commandId} room=${plan.roomId} revision=${plan.revision} recipients=${plan.deliveries.length} emitted=${emitted} skipped=${counts.skipped} failed=${counts.failed} status=${status} phase=${phase}`;
}

function isSuccessCandidate(
  value: unknown,
): value is { status: 'ok'; commandId: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'status' in value &&
    value.status === 'ok' &&
    'commandId' in value
  );
}
