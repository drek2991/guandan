import assert from 'node:assert/strict';
import { setDefaultAutoSelectFamily } from 'node:net';
import { pathToFileURL } from 'node:url';

import { io as createSocketClient } from 'socket.io-client';

setDefaultAutoSelectFamily(false);

const SERVICE_NAME = 'guandan-server';
const SCAFFOLD_PING_EVENT = 'scaffold:ping';
const HTTP_TIMEOUT_MS = 90_000;
const POLLING_CONNECTION_TIMEOUT_MS = 90_000;
const POLLING_ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000;
const WEBSOCKET_CONNECTION_TIMEOUT_MS = 90_000;
const WEBSOCKET_ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseArguments(arguments_) {
  let local = false;
  const values = [];

  for (const argument of arguments_) {
    if (argument === '--local') {
      if (local) {
        throw new Error('--local may appear only once');
      }
      local = true;
    } else {
      values.push(argument);
    }
  }

  if (values.length !== 1) {
    throw new Error('Usage: server:smoke -- [--local] <server-base-url>');
  }

  const suppliedValue = values[0];
  const value = suppliedValue.includes('://')
    ? suppliedValue
    : `https://${suppliedValue}`;
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error('The server base URL is invalid');
  }

  if (url.username || url.password) {
    throw new Error('The server base URL must not contain credentials');
  }

  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('The server base URL must contain only an origin');
  }

  if (local && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('--local accepts only loopback URLs');
  }

  if (url.protocol === 'http:') {
    if (!local) {
      throw new Error('HTTP is allowed only for loopback URLs with --local');
    }
  } else if (url.protocol !== 'https:') {
    throw new Error('The server base URL must use HTTPS');
  }

  url.pathname = '/';
  return { baseUrl: url.origin, local };
}

export async function runSmokeTest(
  baseUrl,
  {
    fetchImplementation = fetch,
    socketFactory = createSocketClient,
    httpTimeoutMs = HTTP_TIMEOUT_MS,
    pollingConnectionTimeoutMs = POLLING_CONNECTION_TIMEOUT_MS,
    pollingAcknowledgementTimeoutMs = POLLING_ACKNOWLEDGEMENT_TIMEOUT_MS,
    websocketConnectionTimeoutMs = WEBSOCKET_CONNECTION_TIMEOUT_MS,
    websocketAcknowledgementTimeoutMs = WEBSOCKET_ACKNOWLEDGEMENT_TIMEOUT_MS,
  } = {},
) {
  await verifyJsonEndpoint(
    new URL('/health', baseUrl),
    { status: 'healthy', service: SERVICE_NAME },
    fetchImplementation,
    httpTimeoutMs,
  );
  await verifyJsonEndpoint(
    new URL('/ready', baseUrl),
    { status: 'ready', service: SERVICE_NAME },
    fetchImplementation,
    httpTimeoutMs,
  );

  await verifySocketTransport(baseUrl, socketFactory, {
    transport: 'polling',
    label: 'polling',
    connectionTimeoutMs: pollingConnectionTimeoutMs,
    acknowledgementTimeoutMs: pollingAcknowledgementTimeoutMs,
  });
  await verifySocketTransport(baseUrl, socketFactory, {
    transport: 'websocket',
    label: 'WebSocket',
    connectionTimeoutMs: websocketConnectionTimeoutMs,
    acknowledgementTimeoutMs: websocketAcknowledgementTimeoutMs,
  });
}

async function verifyJsonEndpoint(
  url,
  expectedBody,
  fetchImplementation,
  timeoutMs,
) {
  let response;

  try {
    response = await fetchImplementation(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`${url.pathname} request failed`);
  }

  if (response.status !== 200) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${url.pathname} returned invalid JSON`);
  }

  try {
    assert.deepEqual(body, expectedBody);
  } catch {
    throw new Error(`${url.pathname} returned an unexpected response`);
  }
}

async function verifySocketTransport(
  baseUrl,
  socketFactory,
  { transport, label, connectionTimeoutMs, acknowledgementTimeoutMs },
) {
  const socket = socketFactory(baseUrl, {
    transports: [transport],
    forceNew: true,
    reconnection: false,
    timeout: connectionTimeoutMs,
  });

  try {
    await waitForConnection(socket, label, connectionTimeoutMs);
    await waitForAcknowledgement(socket, label, acknowledgementTimeoutMs);
  } finally {
    socket.disconnect();
  }
}

function waitForConnection(socket, label, timeoutMs) {
  if (socket.connected) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleError);
    };
    const handleConnect = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(
        new Error(
          `Socket.IO ${label} connection failed: ${sanitizeReason(error)}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Socket.IO ${label} connection timed out`));
    }, timeoutMs);

    socket.once('connect', handleConnect);
    socket.once('connect_error', handleError);
  });
}

function waitForAcknowledgement(socket, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Socket.IO ${label} acknowledgement timed out`));
    }, timeoutMs);

    try {
      socket.emit(SCAFFOLD_PING_EVENT, (response) => {
        clearTimeout(timer);
        try {
          assert.deepEqual(response, { status: 'ok' });
          resolve();
        } catch {
          reject(
            new Error(
              `Socket.IO ${label} returned an unexpected acknowledgement`,
            ),
          );
        }
      });
    } catch (error) {
      clearTimeout(timer);
      reject(
        new Error(
          `Socket.IO ${label} acknowledgement failed: ${sanitizeReason(error)}`,
        ),
      );
    }
  });
}

function sanitizeReason(error) {
  const reason =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error';
  const sanitized = reason
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\s+/g, ' ')
    .trim();

  return (sanitized || 'unknown error').slice(0, 160);
}

async function main() {
  const { baseUrl } = parseArguments(process.argv.slice(2));
  await runSmokeTest(baseUrl);
  console.log(`Server smoke test passed for ${baseUrl}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Server smoke failed',
    );
    process.exitCode = 1;
  });
}
