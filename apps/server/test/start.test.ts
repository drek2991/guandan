import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import type { Server as HttpServer } from 'node:http';

import type { ServerConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { GuandanServer } from '../src/server.js';
import { startServer } from '../src/start.js';

const TEST_CONFIG: ServerConfig = {
  database: { caPath: 'test-ca.crt', connectionString: 'test-configuration' },
  host: '127.0.0.1',
  port: 0,
};

describe('server and database lifecycle', () => {
  it('checks the database before listening', async () => {
    const events: string[] = [];
    const database = createFakeDatabase({
      onCheck: () => events.push('database-check'),
      onClose: () => events.push('database-close'),
    });
    const server = createFakeServer({
      events,
    });

    const runningServer = await startServer(TEST_CONFIG, {
      createDatabase: () => database,
      createServer: () => server,
    });

    assert.deepEqual(events.slice(0, 2), ['database-check', 'listen']);
    await runningServer.close();
  });

  it('closes server and database after a failed startup check', async () => {
    const events: string[] = [];
    const database = createFakeDatabase({
      checkError: new Error('readiness-failure'),
      onCheck: () => events.push('database-check'),
      onClose: () => events.push('database-close'),
    });
    const server = createFakeServer({ events });

    await assert.rejects(
      startServer(TEST_CONFIG, {
        createDatabase: () => database,
        createServer: () => server,
      }),
      /readiness-failure/,
    );

    assert.deepEqual(events, [
      'database-check',
      'server-close',
      'database-close',
    ]);
  });

  it('closes network resources before the database and remains idempotent', async () => {
    const events: string[] = [];
    const database = createFakeDatabase({
      onClose: () => events.push('database-close'),
    });
    const server = createFakeServer({ events });
    const runningServer = await startServer(TEST_CONFIG, {
      createDatabase: () => database,
      createServer: () => server,
    });

    const firstClose = runningServer.close();
    const secondClose = runningServer.close();

    assert.equal(firstClose, secondClose);
    await Promise.all([firstClose, secondClose]);
    await runningServer.close();
    assert.deepEqual(
      events.filter((event) => event.includes('close')),
      ['server-close', 'database-close'],
    );
  });

  it('attempts database close when network shutdown fails', async () => {
    let databaseCloseCalls = 0;
    const database = createFakeDatabase({
      onClose: () => {
        databaseCloseCalls += 1;
      },
    });
    const server = createFakeServer({
      closeError: new Error('network-close-failure'),
    });
    const runningServer = await startServer(TEST_CONFIG, {
      createDatabase: () => database,
      createServer: () => server,
    });

    await assert.rejects(runningServer.close(), AggregateError);
    assert.equal(databaseCloseCalls, 1);
  });
});

interface FakeDatabaseOptions {
  checkError?: Error;
  onCheck?: () => void;
  onClose?: () => void;
}

function createFakeDatabase(options: FakeDatabaseOptions = {}): Database {
  return {
    async check(): Promise<void> {
      options.onCheck?.();
      if (options.checkError !== undefined) {
        throw options.checkError;
      }
    },
    async close(): Promise<void> {
      options.onClose?.();
    },
  };
}

interface FakeServerOptions {
  closeError?: Error;
  events?: string[];
}

function createFakeServer(options: FakeServerOptions = {}): GuandanServer {
  const emitter = new EventEmitter();
  let listening = false;
  const address: AddressInfo = {
    address: '127.0.0.1',
    family: 'IPv4',
    port: 43210,
  };
  const httpServer = Object.assign(emitter, {
    address: () => (listening ? address : null),
    listen: () => {
      options.events?.push('listen');
      listening = true;
      queueMicrotask(() => emitter.emit('listening'));
      return httpServer;
    },
    get listening() {
      return listening;
    },
  }) as unknown as HttpServer;

  return {
    httpServer,
    io: {} as GuandanServer['io'],
    async close(): Promise<void> {
      options.events?.push('server-close');
      listening = false;
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
    },
  };
}
