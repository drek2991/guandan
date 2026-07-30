import {
  parseLobbySnapshotV1,
  parseRoomId,
  type LobbySnapshotV1,
  type PlayerId,
  type RoomId,
} from '@guandan/protocol';

import type {
  LobbyConnectionMembership,
  LobbyConnectionRegistry,
} from './connection-registry.js';
import { assertValidLobbyRoomState } from './invariants.js';
import type { LobbyRepository } from './repository.js';
import { compareLobbyPlayers, projectLobbySnapshot } from './snapshot.js';

export interface LobbySnapshotDelivery {
  socketId: string;
  playerId: PlayerId;
  snapshot: LobbySnapshotV1;
}

export interface LobbySnapshotDeliveryPlan {
  roomId: RoomId;
  revision: number;
  deliveries: readonly LobbySnapshotDelivery[];
}

export interface LobbySnapshotDeliveryPlanner {
  prepare(roomId: RoomId): LobbySnapshotDeliveryPlan;
}

export interface LobbySnapshotDeliveryPlannerDependencies {
  repository: LobbyRepository;
  connectionRegistry: LobbyConnectionRegistry;
  projectSnapshot?: typeof projectLobbySnapshot;
}

export function createLobbySnapshotDeliveryPlanner(
  dependencies: LobbySnapshotDeliveryPlannerDependencies,
): LobbySnapshotDeliveryPlanner {
  const projectSnapshot = dependencies.projectSnapshot ?? projectLobbySnapshot;

  return {
    prepare(roomId): LobbySnapshotDeliveryPlan {
      const parsedRoomId = parseRoomId(roomId);
      if (parsedRoomId === undefined) {
        throw new Error('Lobby snapshot delivery room ID is invalid');
      }

      const room = dependencies.repository.getById(parsedRoomId);
      if (room === undefined) {
        throw new Error('Lobby snapshot delivery room was not found');
      }
      assertValidLobbyRoomState(room);

      const memberships =
        dependencies.connectionRegistry.listByRoomId(parsedRoomId);
      validateMemberships(
        memberships,
        parsedRoomId,
        room.players.map((player) => player.playerId),
      );

      const membershipsByPlayerId = new Map(
        memberships.map((membership) => [membership.playerId, membership]),
      );
      const orderedMemberships = [...room.players]
        .sort(compareLobbyPlayers)
        .map((player) => membershipsByPlayerId.get(player.playerId))
        .filter(
          (membership): membership is LobbyConnectionMembership =>
            membership !== undefined,
        );

      const deliveries = orderedMemberships.map((membership) => {
        const snapshot = parseLobbySnapshotV1(
          projectSnapshot(room, membership.playerId),
        );
        if (
          snapshot === undefined ||
          snapshot.roomId !== parsedRoomId ||
          snapshot.revision !== room.revision ||
          snapshot.selfPlayerId !== membership.playerId ||
          snapshot.players.filter((player) => player.isSelf).length !== 1
        ) {
          throw new Error('Lobby snapshot delivery projection is invalid');
        }

        return Object.freeze({
          socketId: membership.socketId,
          playerId: membership.playerId,
          snapshot: freezeSnapshot(snapshot),
        });
      });

      return Object.freeze({
        roomId: parsedRoomId,
        revision: room.revision,
        deliveries: Object.freeze(deliveries),
      });
    },
  };
}

function validateMemberships(
  memberships: readonly LobbyConnectionMembership[],
  roomId: RoomId,
  playerIds: readonly PlayerId[],
): void {
  const knownPlayerIds = new Set(playerIds);
  const socketIds = new Set<string>();
  const boundPlayerIds = new Set<PlayerId>();

  for (const membership of memberships) {
    if (
      membership.roomId !== roomId ||
      !knownPlayerIds.has(membership.playerId) ||
      socketIds.has(membership.socketId) ||
      boundPlayerIds.has(membership.playerId)
    ) {
      throw new Error('Lobby snapshot delivery membership is invalid');
    }
    socketIds.add(membership.socketId);
    boundPlayerIds.add(membership.playerId);
  }
}

function freezeSnapshot(snapshot: LobbySnapshotV1): LobbySnapshotV1 {
  Object.freeze(snapshot.settings);
  snapshot.players.forEach(Object.freeze);
  Object.freeze(snapshot.players);
  Object.freeze(snapshot.startEligibility.blockers);
  Object.freeze(snapshot.startEligibility);
  Object.freeze(snapshot.capabilities);
  return Object.freeze(snapshot);
}
