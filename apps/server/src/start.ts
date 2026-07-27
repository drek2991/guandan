import type { AddressInfo } from 'node:net';

import type { ServerConfig } from './config.js';
import { createPostgresDatabase, type Database } from './database.js';
import { createGuandanServer, type GuandanServer } from './server.js';

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface RunningServer {
  address: AddressInfo;
  close: () => Promise<void>;
}

export interface StartServerDependencies {
  createDatabase: (config: ServerConfig['database']) => Database;
  createServer: (database: Database) => GuandanServer;
}

const defaultDependencies: StartServerDependencies = {
  createDatabase: createPostgresDatabase,
  createServer: createGuandanServer,
};

export async function startServer(
  config: ServerConfig,
  dependencies: StartServerDependencies = defaultDependencies,
): Promise<RunningServer> {
  const database = dependencies.createDatabase(config.database);
  let server: GuandanServer | undefined;

  try {
    server = dependencies.createServer(database);
    await database.check();
    await listen(server, config);

    const address = server.httpServer.address();

    if (address === null || typeof address === 'string') {
      throw new Error('Server started without a TCP address');
    }

    return {
      address,
      close: createIdempotentClose(server, database),
    };
  } catch (error: unknown) {
    const cleanupErrors = await closeResources(server, database);

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Server startup failed and resource cleanup also failed',
      );
    }

    throw error;
  }
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
        console.log('Server and database shut down cleanly');
        exit(0);
      },
      () => {
        console.error('Server shutdown failed');
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

function createIdempotentClose(
  server: GuandanServer,
  database: Database,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;

  return () => {
    closePromise ??= closeResources(server, database).then((errors) => {
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Server shutdown failed');
      }
    });

    return closePromise;
  };
}

async function closeResources(
  server: GuandanServer | undefined,
  database: Database,
): Promise<unknown[]> {
  const errors: unknown[] = [];

  if (server !== undefined) {
    try {
      await server.close();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  try {
    await database.close();
  } catch (error: unknown) {
    errors.push(error);
  }

  return errors;
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
