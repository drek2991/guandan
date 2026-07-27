import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { parseArguments, runSmokeTest } from '../scripts/smoke.mjs';

const HEALTH_BODY = { status: 'healthy', service: 'guandan-server' };
const READY_BODY = { status: 'ready', service: 'guandan-server' };

describe('server smoke command arguments', () => {
  it('accepts HTTPS URLs and infers HTTPS for a hostname', () => {
    assert.equal(
      parseArguments(['https://service.example']).baseUrl,
      'https://service.example',
    );
    assert.equal(
      parseArguments(['service.example']).baseUrl,
      'https://service.example',
    );
  });

  it('permits HTTP only for explicit loopback local tests', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      assert.equal(
        parseArguments(['--local', `http://${hostname}:3000`]).baseUrl,
        `http://${hostname}:3000`,
      );
    }

    assert.throws(() => parseArguments(['http://localhost:3000']), /HTTP/);
    assert.throws(
      () => parseArguments(['--local', 'http://service.example']),
      /loopback/,
    );
    assert.throws(
      () => parseArguments(['--local', 'https://service.example']),
      /loopback/,
    );
  });

  it('rejects unsafe or ambiguous target URLs', () => {
    for (const arguments_ of [
      [],
      ['one.example', 'two.example'],
      ['--local', '--local', 'http://localhost:3000'],
      ['https://user:secret@service.example'],
      ['https://service.example/path'],
      ['https://service.example?query=value'],
      ['https://service.example#fragment'],
      ['ftp://service.example'],
    ]) {
      assert.throws(() => parseArguments(arguments_));
    }
  });
});

describe('server smoke verification', () => {
  it('verifies health, readiness, and the Socket.IO acknowledgement', async () => {
    const requestedPaths = [];
    const socket = createFakeSocket();

    await runSmokeTest('https://service.example', {
      fetchImplementation: async (url) => {
        requestedPaths.push(url.pathname);
        return Response.json(
          url.pathname === '/health' ? HEALTH_BODY : READY_BODY,
        );
      },
      socketFactory: () => socket,
    });

    assert.deepEqual(requestedPaths, ['/health', '/ready']);
    assert.equal(socket.emittedEvent, 'scaffold:ping');
    assert.equal(socket.disconnected, true);
  });

  it('rejects non-200 and unexpected endpoint responses', async () => {
    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: async () => Response.json({}, { status: 503 }),
        socketFactory: () => createFakeSocket(),
      }),
      /\/health returned HTTP 503/,
    );

    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: async (url) =>
          Response.json(
            url.pathname === '/health'
              ? { ...HEALTH_BODY, diagnostic: 'unexpected' }
              : READY_BODY,
          ),
        socketFactory: () => createFakeSocket(),
      }),
      /\/health returned an unexpected response/,
    );
  });

  it('reports invalid JSON without printing the response body', async () => {
    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: async () => new Response('private upstream page'),
        socketFactory: () => createFakeSocket(),
      }),
      /\/health returned invalid JSON/,
    );
  });

  it('disconnects after an invalid acknowledgement', async () => {
    const socket = createFakeSocket({ acknowledgement: { status: 'wrong' } });

    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: createSuccessfulFetch(),
        socketFactory: () => socket,
      }),
      /Socket.IO scaffold verification failed/,
    );
    assert.equal(socket.disconnected, true);
  });

  it('disconnects after a connection error', async () => {
    const socket = createFakeSocket({ connectionError: true });

    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: createSuccessfulFetch(),
        socketFactory: () => socket,
        socketTimeoutMs: 10,
      }),
      /Socket.IO scaffold verification failed/,
    );
    assert.equal(socket.disconnected, true);
  });
});

function createSuccessfulFetch() {
  return async (url) =>
    Response.json(url.pathname === '/health' ? HEALTH_BODY : READY_BODY);
}

function createFakeSocket(options = {}) {
  const emitter = new EventEmitter();
  const socket = {
    connected: options.connectionError !== true,
    disconnected: false,
    emittedEvent: undefined,
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    emit(event, acknowledge) {
      socket.emittedEvent = event;
      queueMicrotask(() =>
        acknowledge(options.acknowledgement ?? { status: 'ok' }),
      );
    },
    disconnect() {
      socket.disconnected = true;
    },
  };

  queueMicrotask(() =>
    emitter.emit(options.connectionError ? 'connect_error' : 'connect'),
  );
  return socket;
}
