import type {
  LobbyStartBlocker,
  LobbyStartEligibility,
} from '@guandan/protocol';

import { assertValidLobbyRoomState } from './invariants.js';
import type { LobbyRoomState } from './model.js';

export function deriveLobbyStartEligibility(
  room: LobbyRoomState,
): LobbyStartEligibility {
  assertValidLobbyRoomState(room);

  const blockers: LobbyStartBlocker[] = [];
  if (room.players.length !== 4) {
    blockers.push('NOT_FOUR_PLAYERS');
  }
  if (room.players.filter((player) => player.seat !== null).length !== 4) {
    blockers.push('NOT_FOUR_SEATS_OCCUPIED');
  }
  if (!room.players.every((player) => player.ready)) {
    blockers.push('NOT_ALL_PLAYERS_READY');
  }

  return {
    eligible: blockers.length === 0,
    blockers,
  };
}
