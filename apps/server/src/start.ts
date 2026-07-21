import type { AddressInfo } from 'node:net';

import { readConfig, type ServerConfig } from './config.js';
import { createGuandanServer, type GuandanServer } from './server.js';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface RunningServer {
  address: AddressInfo;
  close: () => Promise<void>;
}

export async function startServer(config: ServerConfig = readConfig()): Promise<RunningServer> {
  const server = createGuandanServer();

  try {
    await listen(server, config);
  } catch (error: unknown) {
    await server.close();
    throw error;
  }

  const address = server.httpServer.address();

  if (address === null || typeof address === 'string') {
    await server.close();
    throw new Error('Server started without a TCP address');
  }

  return {
    address,
    close: server.close,
  };
}

export function registerShutdownHandlers(
  runningServer: RunningServer,
  exit: (code: number) => void = process.exit,
): () => void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);

    void runningServer.close().then(
      () => {
        console.log('Server shut down cleanly');
        exit(0);
      },
      (error: unknown) => {
        console.error('Server shutdown failed', error);
        exit(1);
      },
    );
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, shutdown);
  }

  return () => {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.off(signal, shutdown);
    }
  };
}

function listen(server: GuandanServer, config: ServerConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.httpServer.off('listening', handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.httpServer.off('error', handleError);
      resolve();
    };

    server.httpServer.once('error', handleError);
    server.httpServer.once('listening', handleListening);
    server.httpServer.listen(config.port, config.host);
  });
}
