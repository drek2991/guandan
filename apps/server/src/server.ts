import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';

import {
  INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
  LOBBY_CREATE_ROOM_EVENT,
  SCAFFOLD_PING_EVENT,
  isInfrastructureSmokeIdentifier,
  parseCommandId,
  parseInfrastructureDatabaseSmokeCommand,
  type CreateRoomAcknowledgement,
  type InfrastructureDatabaseSmokeAcknowledgement,
  type InfrastructureSmokeErrorCode,
  type ScaffoldClientToServerEvents,
  type ScaffoldServerToClientEvents,
} from '@guandan/protocol';
import { Server as SocketIoServer } from 'socket.io';

import { createApp } from './app.js';
import { InfrastructureSmokeDatabaseError, type Database } from './database.js';
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

      handleCreateRoom(lobbyRuntime, socket.id, payload, acknowledge);
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

function handleCreateRoom(
  lobbyRuntime: LobbyRuntime,
  socketId: string,
  payload: unknown,
  acknowledge: (response: CreateRoomAcknowledgement) => void,
): void {
  let response: CreateRoomAcknowledgement;
  try {
    response = lobbyRuntime.createRoom(socketId, payload);
  } catch {
    response = {
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: 'Room creation failed',
      ...getCreateCommandId(payload),
    };
  }

  acknowledge(response);
  if (response.status === 'ok') {
    console.log(
      `Lobby create-room command=${response.commandId} room=${response.snapshot.roomId} player=${response.snapshot.selfPlayerId} status=ok`,
    );
  } else {
    console.error(
      `Lobby create-room command=${response.commandId ?? 'unknown'} status=error code=${response.code}`,
    );
  }
}

function getCreateCommandId(payload: unknown): { commandId?: string } {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload) &&
    'commandId' in payload
  ) {
    const commandId = parseCommandId(payload.commandId);
    return commandId === undefined ? {} : { commandId };
  }
  return {};
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
