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
import { startServer, type RunningServer } from '../src/start.js';

const app = createApp();

describe('HTTP scaffold', () => {
  it('returns stable service information from GET /health', async () => {
    const response = await request(app).get('/health').expect(200);

    assert.deepEqual(response.body, {
      status: 'healthy',
      service: 'guandan-server',
    });
  });

  it('returns a controlled JSON response for unknown routes', async () => {
    const response = await request(app).get('/missing').expect(404);

    assert.match(response.headers['content-type'] ?? '', /^application\/json/);
    assert.deepEqual(response.body, {
      error: 'not_found',
    });
  });

  it('does not expose stack traces in unexpected HTTP error responses', async () => {
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
    runningServer = await startServer({
      host: '127.0.0.1',
      port: 0,
    });

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
