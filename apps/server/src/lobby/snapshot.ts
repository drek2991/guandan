import {
  LOBBY_SNAPSHOT_VERSION,
  parseLobbySnapshotV1,
  type LobbyCapabilitiesV1,
  type LobbyPlayerSnapshotV1,
  type LobbySnapshotV1,
  type PlayerId,
} from '@guandan/protocol';

import { assertValidLobbyRoomState } from './invariants.js';
import type { LobbyPlayerState, LobbyRoomState } from './model.js';
import { deriveLobbyStartEligibility } from './start-eligibility.js';

export function projectLobbySnapshot(
  room: LobbyRoomState,
  viewerPlayerId: PlayerId,
): LobbySnapshotV1 {
  assertValidLobbyRoomState(room);

  if (!room.players.some((player) => player.playerId === viewerPlayerId)) {
    throw new Error('Lobby snapshot viewer must be a room member');
  }

  const startEligibility = deriveLobbyStartEligibility(room);
  const viewerIsHost = viewerPlayerId === room.hostPlayerId;
  const capabilities: LobbyCapabilitiesV1 = {
    canChangeSettings: viewerIsHost,
    canManageSeats: viewerIsHost,
    canRemovePlayers: viewerIsHost,
    canStartMatch: viewerIsHost && startEligibility.eligible,
  };
  const players = [...room.players]
    .sort(compareLobbyPlayers)
    .map<LobbyPlayerSnapshotV1>((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      seat: player.seat,
      ready: player.ready,
      connectionStatus: player.connectionStatus,
      isHost: player.playerId === room.hostPlayerId,
      isSelf: player.playerId === viewerPlayerId,
    }));

  const snapshot: LobbySnapshotV1 = {
    version: LOBBY_SNAPSHOT_VERSION,
    phase: 'lobby',
    roomId: room.roomId,
    roomCode: room.roomCode,
    revision: room.revision,
    selfPlayerId: viewerPlayerId,
    hostPlayerId: room.hostPlayerId,
    settings: { ...room.settings },
    players,
    startEligibility,
    capabilities,
  };

  const parsedSnapshot = parseLobbySnapshotV1(snapshot);
  if (parsedSnapshot === undefined) {
    throw new Error('Projected lobby snapshot is invalid');
  }
  return parsedSnapshot;
}

export function compareLobbyPlayers(
  left: LobbyPlayerState,
  right: LobbyPlayerState,
): number {
  if (left.seat !== null && right.seat !== null) {
    return left.seat - right.seat;
  }
  if (left.seat !== null) {
    return -1;
  }
  if (right.seat !== null) {
    return 1;
  }
  return left.joinOrder - right.joinOrder;
}
