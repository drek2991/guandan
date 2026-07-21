import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  SCAFFOLD_PING_EVENT,
  type ScaffoldClientToServerEvents,
  type ScaffoldPingResponse,
  type ScaffoldServerToClientEvents,
} from '@guandan/protocol';
import { io as createSocketClient, type Socket } from 'socket.io-client';
import request from 'supertest';

import { createApp } from '../src/app.js';
import type { Database } from '../src/database.js';
import { createGuandanServer } from '../src/server.js';
import { startServer, type RunningServer } from '../src/start.js';

const READY_ERROR_MARKER = 'database-detail-marker';

function createFakeDatabase(options?: {
  checkError?: Error;
  onCheck?: () => void;
  onClose?: () => void;
}): Database {
  return {
    async check(): Promise<void> {
      options?.onCheck?.();
      if (options?.checkError !== undefined) {
        throw options.checkError;
      }
    },
    async close(): Promise<void> {
      options?.onClose?.();
    },
  };
}

describe('HTTP scaffold', () => {
  it('returns stable service information from GET /health without checking the database', async () => {
    let checkCalls = 0;
    const app = createApp(
      createFakeDatabase({
        checkError: new Error(READY_ERROR_MARKER),
        onCheck: () => {
          checkCalls += 1;
        },
      }),
    );
    const response = await request(app).get('/health').expect(200);

    assert.deepEqual(response.body, {
      status: 'healthy',
      service: 'guandan-server',
    });
    assert.equal(checkCalls, 0);
  });

  it('returns HTTP 200 when the database is ready', async () => {
    const app = createApp(createFakeDatabase());
    const response = await request(app).get('/ready').expect(200);

    assert.deepEqual(response.body, {
      status: 'ready',
      service: 'guandan-server',
    });
  });

  it('returns a sanitized HTTP 503 when the database is not ready', async () => {
    const app = createApp(
      createFakeDatabase({
        checkError: new Error(READY_ERROR_MARKER),
      }),
    );
    const response = await request(app).get('/ready').expect(503);

    assert.deepEqual(response.body, {
      status: 'not_ready',
      service: 'guandan-server',
    });
    assert.equal(response.text.includes(READY_ERROR_MARKER), false);
  });

  it('returns a controlled JSON response for unknown routes', async () => {
    const app = createApp(createFakeDatabase());
    const response = await request(app).get('/missing').expect(404);

    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    assert.deepEqual(response.body, {
      error: 'not_found',
    });
  });

  it('does not expose stack traces in unexpected HTTP error responses', async () => {
    const app = createApp(createFakeDatabase());
    const response = await request(app)
      .post('/health')
      .set('content-type', 'application/json')
      .send('{')
      .expect(500);

    assert.deepEqual(response.body, {
      error: 'internal_server_error',
    });
    assert.equal(response.text.includes('SyntaxError'), false);
  });
});

describe('Socket.IO scaffold', () => {
  let runningServer: RunningServer;
  let client: Socket<
    ScaffoldServerToClientEvents,
    ScaffoldClientToServerEvents
  >;

  before(async () => {
    const database = createFakeDatabase();
    runningServer = await startServer(
      {
        database: {
          caPath: 'test-ca.crt',
          connectionString: 'test-configuration',
        },
        host: '127.0.0.1',
        port: 0,
      },
      {
        createDatabase: () => database,
        createServer: createGuandanServer,
      },
    );

    client = createSocketClient(
      `http://127.0.0.1:${runningServer.address.port}`,
      {
        forceNew: true,
        reconnection: false,
        transports: ['websocket'],
      },
    );

    await waitForConnection(client);
  });

  after(async () => {
    client.disconnect();
    await runningServer.close();
  });

  it('connects and acknowledges the scaffold connectivity event', async () => {
    const response = await waitForAcknowledgement(client);

    assert.deepEqual(response, {
      status: 'ok',
    });
  });
});

function waitForAcknowledgement(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
): Promise<ScaffoldPingResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO acknowledgement timed out'));
    }, 5_000);

    client.emit(SCAFFOLD_PING_EVENT, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForConnection(
  client: Socket<ScaffoldServerToClientEvents, ScaffoldClientToServerEvents>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO client connection timed out'));
    }, 5_000);

    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
