import {
  INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
  parseInfrastructureDatabaseSmokeAcknowledgement,
  type InfrastructureDatabaseSmokeAcknowledgement,
  type InfrastructureDatabaseSmokeCommand,
  type InfrastructureDatabaseSmokeSuccess,
} from '@guandan/protocol';
const publicServerUrl: unknown = process.env.EXPO_PUBLIC_SERVER_URL;

export const SERVER_URL =
  typeof publicServerUrl === 'string' ? publicServerUrl : undefined;
export const CONNECTION_TIMEOUT_MS = 90_000;
export const ACKNOWLEDGEMENT_TIMEOUT_MS = 15_000;

export type SmokePhase =
  'idle' | 'connecting' | 'waiting' | 'success' | 'failure';

export interface SmokeSuccessResult {
  phase: 'success';
  acknowledgement: InfrastructureDatabaseSmokeSuccess;
}

export interface SmokeFailureResult {
  phase: 'failure';
  category:
    | 'configuration'
    | 'connection'
    | 'connection-timeout'
    | 'acknowledgement-timeout'
    | 'invalid-acknowledgement'
    | 'server';
  message: string;
  code?: string;
}

export type SmokeTerminalResult = SmokeSuccessResult | SmokeFailureResult;

export interface SmokeRunLock {
  current: boolean;
}

export function acquireSmokeRun(lock: SmokeRunLock): boolean {
  if (lock.current) {
    return false;
  }

  lock.current = true;
  return true;
}

export function releaseSmokeRun(lock: SmokeRunLock): void {
  lock.current = false;
}

interface SmokeSocket {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  on(
    event: 'connect' | 'connect_error',
    listener: (...args: never[]) => void,
  ): this;
  off(
    event: 'connect' | 'connect_error',
    listener: (...args: never[]) => void,
  ): this;
  timeout(milliseconds: number): {
    emitWithAck(
      event: typeof INFRASTRUCTURE_DATABASE_SMOKE_EVENT,
      command: InfrastructureDatabaseSmokeCommand,
    ): Promise<unknown>;
  };
}

export interface RunSmokeDependencies {
  createIdentifier: () => string;
  createSocket: (url: string) => SmokeSocket;
  connectionTimeoutMs: number;
  acknowledgementTimeoutMs: number;
}

const missingDependencies: RunSmokeDependencies = {
  createIdentifier: () => {
    throw new Error('Smoke identifier generator is unavailable');
  },
  createSocket: () => {
    throw new Error('Smoke socket factory is unavailable');
  },
  connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
  acknowledgementTimeoutMs: ACKNOWLEDGEMENT_TIMEOUT_MS,
};

export function createRunSmokeDependencies(
  createIdentifier: () => string,
  createSocket: RunSmokeDependencies['createSocket'],
): RunSmokeDependencies {
  return {
    createIdentifier,
    createSocket,
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    acknowledgementTimeoutMs: ACKNOWLEDGEMENT_TIMEOUT_MS,
  };
}

export function parseServerUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return undefined;
  }

  return url.origin;
}

export function getServerHost(value: string | undefined): string {
  const serverUrl = parseServerUrl(value);
  return serverUrl === undefined ? 'Not configured' : new URL(serverUrl).host;
}

export async function runInfrastructureSmoke(
  serverUrlValue: string | undefined,
  onPhase: (phase: 'connecting' | 'waiting') => void,
  dependencies: RunSmokeDependencies = missingDependencies,
): Promise<SmokeTerminalResult> {
  const serverUrl = parseServerUrl(serverUrlValue);
  if (serverUrl === undefined) {
    return {
      phase: 'failure',
      category: 'configuration',
      message: 'Set EXPO_PUBLIC_SERVER_URL to a valid server origin.',
    };
  }

  const command = {
    commandId: dependencies.createIdentifier(),
    probeToken: dependencies.createIdentifier(),
  };
  const socket = dependencies.createSocket(serverUrl);

  try {
    onPhase('connecting');
    const connectionResult = await waitForConnection(
      socket,
      dependencies.connectionTimeoutMs,
    );
    if (connectionResult !== 'connected') {
      return connectionResult;
    }

    onPhase('waiting');
    let rawAcknowledgement: unknown;
    try {
      rawAcknowledgement = await socket
        .timeout(dependencies.acknowledgementTimeoutMs)
        .emitWithAck(INFRASTRUCTURE_DATABASE_SMOKE_EVENT, command);
    } catch {
      return {
        phase: 'failure',
        category: 'acknowledgement-timeout',
        message:
          'The server did not acknowledge database verification in time.',
      };
    }

    return evaluateAcknowledgement(rawAcknowledgement, command);
  } finally {
    socket.disconnect();
  }
}

export function evaluateAcknowledgement(
  value: unknown,
  command: InfrastructureDatabaseSmokeCommand,
): SmokeTerminalResult {
  const acknowledgement =
    parseInfrastructureDatabaseSmokeAcknowledgement(value);

  if (acknowledgement === undefined) {
    return {
      phase: 'failure',
      category: 'invalid-acknowledgement',
      message: 'The server returned an invalid acknowledgement.',
    };
  }

  if (acknowledgement.status === 'error') {
    return serverFailure(acknowledgement);
  }

  if (
    acknowledgement.commandId !== command.commandId ||
    acknowledgement.probeToken !== command.probeToken
  ) {
    return {
      phase: 'failure',
      category: 'invalid-acknowledgement',
      message: 'The returned identifiers did not match this request.',
    };
  }

  return { phase: 'success', acknowledgement };
}

async function waitForConnection(
  socket: SmokeSocket,
  timeoutMs: number,
): Promise<'connected' | SmokeFailureResult> {
  if (socket.connected) {
    return 'connected';
  }

  return new Promise((resolve) => {
    let timedOut = false;
    const finish = (result: 'connected' | SmokeFailureResult): void => {
      clearTimeout(timer);
      socket.off('connect', handleConnect);
      socket.off('connect_error', handleError);
      resolve(result);
    };
    const handleConnect = (): void => {
      finish('connected');
    };
    const handleError = (): void => {
      if (!timedOut) {
        finish({
          phase: 'failure',
          category: 'connection',
          message: 'Could not connect to the configured server.',
        });
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish({
        phase: 'failure',
        category: 'connection-timeout',
        message:
          'Server connection timed out. A Render cold start may be in progress.',
      });
    }, timeoutMs);

    socket.on('connect', handleConnect);
    socket.on('connect_error', handleError);
    socket.connect();
  });
}

function serverFailure(
  acknowledgement: InfrastructureDatabaseSmokeAcknowledgement & {
    status: 'error';
  },
): SmokeFailureResult {
  return {
    phase: 'failure',
    category: 'server',
    message: acknowledgement.message,
    code: acknowledgement.code,
  };
}
