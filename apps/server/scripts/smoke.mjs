import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { io as createSocketClient } from 'socket.io-client';

const SERVICE_NAME = 'guandan-server';
const SCAFFOLD_PING_EVENT = 'scaffold:ping';
const HTTP_TIMEOUT_MS = 90_000;
const SOCKET_TIMEOUT_MS = 15_000;
const ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;
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
    socketTimeoutMs = SOCKET_TIMEOUT_MS,
    acknowledgementTimeoutMs = ACKNOWLEDGEMENT_TIMEOUT_MS,
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

  const socket = socketFactory(baseUrl, {
    forceNew: true,
    reconnection: false,
    timeout: socketTimeoutMs,
  });

  try {
    await waitForConnection(socket, socketTimeoutMs);
    const acknowledgement = await waitForAcknowledgement(
      socket,
      acknowledgementTimeoutMs,
    );
    assert.deepEqual(acknowledgement, { status: 'ok' });
  } catch {
    throw new Error('Socket.IO scaffold verification failed');
  } finally {
    socket.disconnect();
  }
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

function waitForConnection(socket, timeoutMs) {
  if (socket.connected) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Socket.IO connection timed out'));
    }, timeoutMs);
    const handleConnect = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error('Socket.IO connection failed'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleError);
    };

    socket.once('connect', handleConnect);
    socket.once('connect_error', handleError);
  });
}

function waitForAcknowledgement(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Socket.IO acknowledgement timed out'));
    }, timeoutMs);

    socket.emit(SCAFFOLD_PING_EVENT, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function main() {
  const { baseUrl } = parseArguments(process.argv.slice(2));
  await runSmokeTest(baseUrl);
  console.log(`Server smoke test passed for ${baseUrl}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Server smoke test failed',
    );
    process.exitCode = 1;
  });
}
