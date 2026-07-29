import type {
  DisplayName,
  LobbyConnectionStatus,
  PlayerId,
  RoomCode,
  RoomId,
  RoomRevision,
  SeatIndex,
  StartingLevel,
  TurnTimer,
} from '@guandan/protocol';

export interface LobbyRoomSettings {
  startingLevel: StartingLevel;
  turnTimer: TurnTimer;
  hasPassword: boolean;
}

export interface LobbyPlayerState {
  playerId: PlayerId;
  displayName: DisplayName;
  displayNameKey: string;
  joinOrder: number;
  seat: SeatIndex | null;
  ready: boolean;
  connectionStatus: LobbyConnectionStatus;
}

export interface LobbyRoomState {
  roomId: RoomId;
  roomCode: RoomCode;
  revision: RoomRevision;
  phase: 'lobby';
  hostPlayerId: PlayerId;
  settings: LobbyRoomSettings;
  players: LobbyPlayerState[];
}
