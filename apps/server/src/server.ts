import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';

import {
  INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
  LOBBY_CREATE_ROOM_EVENT,
  LOBBY_JOIN_ROOM_EVENT,
  LOBBY_SET_SEAT_EVENT,
  SCAFFOLD_PING_EVENT,
  isInfrastructureSmokeIdentifier,
  parseCommandId,
  parseCreateRoomErrorAcknowledgement,
  parseCreateRoomSuccess,
  parseInfrastructureDatabaseSmokeCommand,
  parseJoinRoomErrorAcknowledgement,
  parseJoinRoomSuccess,
  parseSetSeatErrorAcknowledgement,
  parseSetSeatSuccess,
  type CommandId,
  type CreateRoomAcknowledgement,
  type InfrastructureDatabaseSmokeAcknowledgement,
  type InfrastructureSmokeErrorCode,
  type JoinRoomAcknowledgement,
  type ScaffoldClientToServerEvents,
  type SetSeatAcknowledgement,
  type ScaffoldServerToClientEvents,
} from '@guandan/protocol';
import { Server as SocketIoServer, type Socket } from 'socket.io';

import { createApp } from './app.js';
import { InfrastructureSmokeDatabaseError, type Database } from './database.js';
import { completeLobbyCommandTransport } from './lobby/command-transport.js';
import { createLobbyRuntime, type LobbyRuntime } from './lobby/runtime.js';

export interface GuandanServer {
  httpServer: HttpServer;
  io: SocketIoServer<
    ScaffoldClientToServerEvents,
    ScaffoldServerToClientEvents
  >;
  close: () => Promise<void>;
}

export function createGuandanServer(
  database: Database,
  lobbyRuntime: LobbyRuntime = createLobbyRuntime(),
): GuandanServer {
  const app = createApp(database);
  const httpServer = createHttpServer(app);
  const io = new SocketIoServer<
    ScaffoldClientToServerEvents,
    ScaffoldServerToClientEvents
  >(httpServer);

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on(SCAFFOLD_PING_EVENT, (acknowledge) => {
      acknowledge({ status: 'ok' });
    });

    socket.on(INFRASTRUCTURE_DATABASE_SMOKE_EVENT, (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') {
        console.error(
          'Infrastructure database smoke rejected: acknowledgement callback missing',
        );
        return;
      }

      void handleInfrastructureDatabaseSmoke(database, payload, acknowledge);
    });

    socket.on(LOBBY_CREATE_ROOM_EVENT, (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') {
        console.error(
          'Lobby create-room rejected: acknowledgement callback missing',
        );
        return;
      }

      void handleCreateRoom(io, lobbyRuntime, socket, payload, acknowledge);
    });

    socket.on(LOBBY_JOIN_ROOM_EVENT, (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') {
        console.error(
          'Lobby join-room rejected: acknowledgement callback missing',
        );
        return;
      }

      void handleJoinRoom(io, lobbyRuntime, socket, payload, acknowledge);
    });

    socket.on(LOBBY_SET_SEAT_EVENT, (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') {
        console.error(
          'Lobby set-seat rejected: acknowledgement callback missing',
        );
        return;
      }

      void handleSetSeat(io, lobbyRuntime, socket, payload, acknowledge);
    });

    socket.on('disconnect', (reason) => {
      console.log(`Socket disconnected: ${socket.id} (${reason})`);
    });
  });

  return {
    httpServer,
    io,
    close: () => closeServer(io, httpServer),
  };
}

type LobbySocket = Socket<
  ScaffoldClientToServerEvents,
  ScaffoldServerToClientEvents
>;
type LobbySocketServer = SocketIoServer<
  ScaffoldClientToServerEvents,
  ScaffoldServerToClientEvents
>;

async function handleCreateRoom(
  io: LobbySocketServer,
  lobbyRuntime: LobbyRuntime,
  socket: LobbySocket,
  payload: unknown,
  acknowledge: (response: CreateRoomAcknowledgement) => void,
): Promise<void> {
  let response: CreateRoomAcknowledgement;
  try {
    response = lobbyRuntime.createRoom(socket.id, payload);
  } catch {
    response = createRoomInternalError(payload);
  }

  const completion = await completeLobbyCommandTransport(response, {
    commandKind: 'create-room',
    initiatingSocket: socket,
    getActiveSocket: (socketId) => io.sockets.sockets.get(socketId),
    prepareDeliveries: (roomId) =>
      lobbyRuntime.prepareLobbySnapshotDeliveries(roomId),
    parseSuccess: parseCreateRoomSuccess,
    createInternalError: createRoomInternalError,
    logger: { info: console.log, error: console.error },
  });
  acknowledge(completion.acknowledgement);
  completion.afterAcknowledgement?.();
  logCommandError('create-room', completion.acknowledgement);
}

async function handleJoinRoom(
  io: LobbySocketServer,
  lobbyRuntime: LobbyRuntime,
  socket: LobbySocket,
  payload: unknown,
  acknowledge: (response: JoinRoomAcknowledgement) => void,
): Promise<void> {
  let response: JoinRoomAcknowledgement;
  try {
    response = lobbyRuntime.joinRoom(socket.id, payload);
  } catch {
    response = createJoinRoomInternalError(payload);
  }

  const completion = await completeLobbyCommandTransport(response, {
    commandKind: 'join-room',
    initiatingSocket: socket,
    getActiveSocket: (socketId) => io.sockets.sockets.get(socketId),
    prepareDeliveries: (roomId) =>
      lobbyRuntime.prepareLobbySnapshotDeliveries(roomId),
    parseSuccess: parseJoinRoomSuccess,
    createInternalError: createJoinRoomInternalError,
    logger: { info: console.log, error: console.error },
  });
  acknowledge(completion.acknowledgement);
  completion.afterAcknowledgement?.();
  logCommandError('join-room', completion.acknowledgement);
}

async function handleSetSeat(
  io: LobbySocketServer,
  lobbyRuntime: LobbyRuntime,
  socket: LobbySocket,
  payload: unknown,
  acknowledge: (response: SetSeatAcknowledgement) => void,
): Promise<void> {
  let response: SetSeatAcknowledgement;
  try {
    response = lobbyRuntime.setSeat(socket.id, payload);
  } catch {
    response = createSetSeatInternalError(payload);
  }

  const completion = await completeLobbyCommandTransport(response, {
    commandKind: 'set-seat',
    initiatingSocket: socket,
    getActiveSocket: (socketId) => io.sockets.sockets.get(socketId),
    prepareDeliveries: (roomId) =>
      lobbyRuntime.prepareLobbySnapshotDeliveries(roomId),
    parseSuccess: parseSetSeatSuccess,
    createInternalError: createSetSeatInternalError,
    logger: { info: console.log, error: console.error },
  });
  acknowledge(completion.acknowledgement);
  completion.afterAcknowledgement?.();
  logCommandError('set-seat', completion.acknowledgement);
}

function createRoomInternalError(value: unknown): CreateRoomAcknowledgement {
  const commandId = getCommandId(value);
  const response = parseCreateRoomErrorAcknowledgement({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: 'Room creation failed',
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (response === undefined) {
    throw new Error('Create-room internal error is invalid');
  }
  return response;
}

function createJoinRoomInternalError(value: unknown): JoinRoomAcknowledgement {
  const commandId = getCommandId(value);
  const response = parseJoinRoomErrorAcknowledgement({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: 'Room join failed',
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (response === undefined) {
    throw new Error('Join-room internal error is invalid');
  }
  return response;
}

function createSetSeatInternalError(value: unknown): SetSeatAcknowledgement {
  const commandId = getCommandId(value);
  const response = parseSetSeatErrorAcknowledgement({
    status: 'error',
    code: 'INTERNAL_ERROR',
    message: 'Seat selection failed',
    ...(commandId === undefined ? {} : { commandId }),
  });
  if (response === undefined) {
    throw new Error('Set-seat internal error is invalid');
  }
  return response;
}

function logCommandError(
  commandKind: 'create-room' | 'join-room' | 'set-seat',
  response:
    | CreateRoomAcknowledgement
    | JoinRoomAcknowledgement
    | SetSeatAcknowledgement,
): void {
  if (response.status === 'error') {
    console.error(
      `Lobby ${commandKind} command=${response.commandId ?? 'unknown'} status=error code=${response.code}`,
    );
  }
}

function getCommandId(value: unknown): CommandId | undefined {
  if (typeof value === 'string') {
    return parseCommandId(value);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'commandId' in value
  ) {
    return parseCommandId(value.commandId);
  }
  return undefined;
}

async function handleInfrastructureDatabaseSmoke(
  database: Database,
  payload: unknown,
  acknowledge: (response: InfrastructureDatabaseSmokeAcknowledgement) => void,
): Promise<void> {
  const command = parseInfrastructureDatabaseSmokeCommand(payload);

  if (command === undefined) {
    acknowledge({
      status: 'error',
      code: 'INVALID_PAYLOAD',
      message: 'Invalid smoke command payload',
      ...getValidCommandId(payload),
    });
    return;
  }

  try {
    const result = await database.runInfrastructureSmoke(command);

    acknowledge({
      status: 'ok',
      commandId: command.commandId,
      probeToken: command.probeToken,
      databaseVerified: true,
      operation: 'upsert-readback',
      databaseUpdatedAt: result.databaseUpdatedAt.toISOString(),
      completedAt: new Date().toISOString(),
    });
    console.log(
      `Infrastructure database smoke command=${command.commandId} status=ok databaseVerified=true`,
    );
  } catch (error: unknown) {
    const failure = mapInfrastructureSmokeError(error);
    acknowledge({
      status: 'error',
      code: failure.code,
      message: failure.message,
      commandId: command.commandId,
    });
    console.error(
      `Infrastructure database smoke command=${command.commandId} status=error databaseVerified=false code=${failure.code}`,
    );
  }
}

function getValidCommandId(payload: unknown): { commandId?: string } {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'commandId' in payload &&
    isInfrastructureSmokeIdentifier(payload.commandId)
  ) {
    return { commandId: payload.commandId };
  }

  return {};
}

function mapInfrastructureSmokeError(error: unknown): {
  code: InfrastructureSmokeErrorCode;
  message: string;
} {
  if (error instanceof InfrastructureSmokeDatabaseError) {
    switch (error.failure) {
      case 'unavailable':
        return {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database is unavailable',
        };
      case 'write':
        return {
          code: 'DATABASE_WRITE_FAILED',
          message: 'Database write failed',
        };
      case 'readback-mismatch':
        return {
          code: 'DATABASE_READBACK_MISMATCH',
          message: 'Database readback did not match',
        };
      case 'internal':
        break;
    }
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'Smoke operation failed',
  };
}

function closeServer(
  io: SocketIoServer<
    ScaffoldClientToServerEvents,
    ScaffoldServerToClientEvents
  >,
  httpServer: HttpServer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    void io.close(() => {
      if (!httpServer.listening) {
        resolve();
        return;
      }

      httpServer.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });
}
