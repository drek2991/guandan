import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { parseArguments, runSmokeTest } from '../scripts/smoke.mjs';

const HEALTH_BODY = { status: 'healthy', service: 'guandan-server' };
const READY_BODY = { status: 'ready', service: 'guandan-server' };
const SHORT_TIMEOUTS = {
  pollingConnectionTimeoutMs: 50,
  pollingAcknowledgementTimeoutMs: 50,
  websocketConnectionTimeoutMs: 50,
  websocketAcknowledgementTimeoutMs: 50,
};

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
      [
        new URL('https://service.example').href.replace(
          '//',
          ['//user', ':', 'secret@'].join(''),
        ),
      ],
      ['https://service.example/path'],
      ['https://service.example?query=value'],
      ['https://service.example#fragment'],
      ['ftp://service.example'],
    ]) {
      assert.throws(() => parseArguments(arguments_));
    }
  });
});

describe('server smoke HTTP verification', () => {
  it('verifies health and readiness before Socket.IO', async () => {
    const requestedPaths = [];
    const sockets = [];

    await runSmokeTest('https://service.example', {
      fetchImplementation: async (url) => {
        requestedPaths.push(url.pathname);
        return Response.json(
          url.pathname === '/health' ? HEALTH_BODY : READY_BODY,
        );
      },
      socketFactory: (_url, options) => {
        const socket = createFakeSocket();
        sockets.push({ options, socket });
        return socket;
      },
    });

    assert.deepEqual(requestedPaths, ['/health', '/ready']);
    assert.equal(sockets.length, 2);
  });

  it('rejects non-200 and unexpected endpoint responses', async () => {
    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: async () => Response.json({}, { status: 503 }),
        socketFactory: unexpectedSocketFactory,
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
        socketFactory: unexpectedSocketFactory,
      }),
      /\/health returned an unexpected response/,
    );
  });

  it('reports invalid JSON without printing the response body', async () => {
    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: async () => new Response('private upstream page'),
        socketFactory: unexpectedSocketFactory,
      }),
      /\/health returned invalid JSON/,
    );
  });
});

describe('server smoke transport success', () => {
  for (const [transport, label] of [
    ['polling', 'polling'],
    ['websocket', 'WebSocket'],
  ]) {
    it(`verifies ${label} with an exact acknowledgement`, async () => {
      const sockets = [];

      await runSmokeTest('https://service.example', {
        fetchImplementation: createSuccessfulFetch(),
        socketFactory: (_url, options) => {
          const socket = createFakeSocket();
          sockets.push({ options, socket });
          return socket;
        },
      });

      const index = transport === 'polling' ? 0 : 1;
      assert.deepEqual(sockets[index].options.transports, [transport]);
      assert.equal(sockets[index].options.forceNew, true);
      assert.equal(sockets[index].options.reconnection, false);
      assert.equal(sockets[index].socket.emittedEvent, 'scaffold:ping');
      assert.equal(sockets[index].socket.disconnected, true);
      assert.equal(sockets[index].socket.listenerCount(), 0);
    });
  }

  it('runs polling before WebSocket with fresh clients', async () => {
    const transports = [];

    await runSmokeTest('https://service.example', {
      fetchImplementation: createSuccessfulFetch(),
      socketFactory: (_url, options) => {
        transports.push(options.transports[0]);
        return createFakeSocket();
      },
    });

    assert.deepEqual(transports, ['polling', 'websocket']);
  });
});

describe('server smoke connection failures', () => {
  for (const [transport, label, overrides] of [
    ['polling', 'polling', { pollingConnectionTimeoutMs: 1 }],
    ['websocket', 'WebSocket', { websocketConnectionTimeoutMs: 1 }],
  ]) {
    it(`reports ${label} connection timeout and disconnects`, async () => {
      const socket = createFakeSocket({ neverConnect: true });

      await assert.rejects(
        runWithTransportSocket(transport, socket, overrides),
        new RegExp(`Socket\\.IO ${label} connection timed out`),
      );
      assert.equal(socket.disconnected, true);
      assert.equal(socket.listenerCount(), 0);
    });
  }

  for (const [transport, label] of [
    ['polling', 'polling'],
    ['websocket', 'WebSocket'],
  ]) {
    it(`reports sanitized ${label} connection error and disconnects`, async () => {
      const socket = createFakeSocket({
        connectionError: new Error(
          [
            'connection failed for https://user',
            ':',
            'secret@host.example',
          ].join(''),
        ),
      });

      await assert.rejects(
        runWithTransportSocket(transport, socket),
        (error) => {
          assert.match(
            error.message,
            new RegExp(`Socket\\.IO ${label} connection failed:`),
          );
          assert.equal(error.message.includes('secret'), false);
          return true;
        },
      );
      assert.equal(socket.disconnected, true);
      assert.equal(socket.listenerCount(), 0);
    });
  }
});

describe('server smoke acknowledgement failures', () => {
  for (const [transport, label, overrides] of [
    ['polling', 'polling', { pollingAcknowledgementTimeoutMs: 1 }],
    ['websocket', 'WebSocket', { websocketAcknowledgementTimeoutMs: 1 }],
  ]) {
    it(`reports ${label} acknowledgement timeout and disconnects`, async () => {
      const socket = createFakeSocket({ neverAcknowledge: true });

      await assert.rejects(
        runWithTransportSocket(transport, socket, overrides),
        new RegExp(`Socket\\.IO ${label} acknowledgement timed out`),
      );
      assert.equal(socket.disconnected, true);
      assert.equal(socket.listenerCount(), 0);
    });
  }

  for (const [transport, label] of [
    ['polling', 'polling'],
    ['websocket', 'WebSocket'],
  ]) {
    it(`reports invalid ${label} acknowledgement and disconnects`, async () => {
      const socket = createFakeSocket({ acknowledgement: { status: 'wrong' } });

      await assert.rejects(
        runWithTransportSocket(transport, socket),
        new RegExp(
          `Socket\\.IO ${label} returned an unexpected acknowledgement`,
        ),
      );
      assert.equal(socket.disconnected, true);
      assert.equal(socket.listenerCount(), 0);
    });
  }
});

describe('server smoke transport ordering', () => {
  it('does not start WebSocket when polling verification fails', async () => {
    const transports = [];
    const pollingSocket = createFakeSocket({
      connectionError: new Error('down'),
    });

    await assert.rejects(
      runSmokeTest('https://service.example', {
        fetchImplementation: createSuccessfulFetch(),
        socketFactory: (_url, options) => {
          transports.push(options.transports[0]);
          return pollingSocket;
        },
        ...SHORT_TIMEOUTS,
      }),
      /Socket\.IO polling connection failed: down/,
    );

    assert.deepEqual(transports, ['polling']);
    assert.equal(pollingSocket.disconnected, true);
  });
});

function runWithTransportSocket(transport, targetSocket, overrides = {}) {
  return runSmokeTest('https://service.example', {
    fetchImplementation: createSuccessfulFetch(),
    socketFactory: (_url, options) => {
      if (options.transports[0] === transport) {
        return targetSocket;
      }
      return createFakeSocket();
    },
    ...SHORT_TIMEOUTS,
    ...overrides,
  });
}

function createSuccessfulFetch() {
  return async (url) =>
    Response.json(url.pathname === '/health' ? HEALTH_BODY : READY_BODY);
}

function unexpectedSocketFactory() {
  throw new Error('Socket factory should not be called');
}

function createFakeSocket(options = {}) {
  const emitter = new EventEmitter();
  const socket = {
    connected: false,
    disconnected: false,
    emittedEvent: undefined,
    once(event, listener) {
      emitter.once(event, listener);
      if (event === 'connect_error' && options.connectionError !== undefined) {
        queueMicrotask(() =>
          emitter.emit('connect_error', options.connectionError),
        );
      } else if (
        event === 'connect' &&
        options.connectionError === undefined &&
        !options.neverConnect
      ) {
        queueMicrotask(() => {
          socket.connected = true;
          emitter.emit('connect');
        });
      }
      return socket;
    },
    off: emitter.off.bind(emitter),
    emit(event, acknowledge) {
      socket.emittedEvent = event;
      if (!options.neverAcknowledge) {
        queueMicrotask(() =>
          acknowledge(options.acknowledgement ?? { status: 'ok' }),
        );
      }
    },
    disconnect() {
      socket.disconnected = true;
    },
    listenerCount() {
      return (
        emitter.listenerCount('connect') +
        emitter.listenerCount('connect_error')
      );
    },
  };

  return socket;
}
