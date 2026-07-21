import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';

import {
  SCAFFOLD_PING_EVENT,
  type ScaffoldClientToServerEvents,
  type ScaffoldServerToClientEvents,
} from '@guandan/protocol';
import { Server as SocketIoServer } from 'socket.io';

import { createApp } from './app.js';
import type { Database } from './database.js';

export interface GuandanServer {
  httpServer: HttpServer;
  io: SocketIoServer<
    ScaffoldClientToServerEvents,
    ScaffoldServerToClientEvents
  >;
  close: () => Promise<void>;
}

export function createGuandanServer(database: Database): GuandanServer {
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
