import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateAcknowledgement,
  parseServerUrl,
  runInfrastructureSmoke,
  type RunSmokeDependencies,
} from '../src/infrastructure-smoke.js';

const COMMAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROBE_TOKEN = '8f14e45f-ea1e-4b29-bad7-6e7f5f541234';
const SUCCESS = {
  status: 'ok',
  commandId: COMMAND_ID,
  probeToken: PROBE_TOKEN,
  databaseVerified: true,
  operation: 'upsert-readback',
  databaseUpdatedAt: '2026-07-27T12:00:00.000Z',
  completedAt: '2026-07-27T12:00:01.000Z',
};

describe('mobile server configuration', () => {
  it('accepts public HTTP and HTTPS origins', () => {
    assert.equal(
      parseServerUrl('https://guandan-server.example'),
      'https://guandan-server.example',
    );
    assert.equal(
      parseServerUrl('http://192.0.2.1:3000'),
      'http://192.0.2.1:3000',
    );
  });

  for (const value of [
    undefined,
    '',
    ' https://server.example',
    'ftp://server.example',
    'https://user:pass@server.example',
    'https://server.example/path',
    'https://server.example?query=1',
    'https://server.example#fragment',
  ]) {
    it(`rejects invalid server URL ${String(value)}`, () => {
      assert.equal(parseServerUrl(value), undefined);
    });
  }
});

describe('mobile acknowledgement evaluation', () => {
  it('accepts a valid success acknowledgement', () => {
    assert.deepEqual(
      evaluateAcknowledgement(SUCCESS, {
        commandId: COMMAND_ID,
        probeToken: PROBE_TOKEN,
      }),
      { phase: 'success', acknowledgement: SUCCESS },
    );
  });

  it('rejects returned identifier mismatches', () => {
    const result = evaluateAcknowledgement(
      { ...SUCCESS, probeToken: 'a8098c1a-f86e-4b3a-b53f-74a0f9e8d123' },
      { commandId: COMMAND_ID, probeToken: PROBE_TOKEN },
    );

    assert.deepEqual(result, {
      phase: 'failure',
      category: 'invalid-acknowledgement',
      message: 'The returned identifiers did not match this request.',
    });
  });

  it('preserves a structured server error code', () => {
    assert.deepEqual(
      evaluateAcknowledgement(
        {
          status: 'error',
          code: 'DATABASE_WRITE_FAILED',
          message: 'Database write failed',
          commandId: COMMAND_ID,
        },
        { commandId: COMMAND_ID, probeToken: PROBE_TOKEN },
      ),
      {
        phase: 'failure',
        category: 'server',
        message: 'Database write failed',
        code: 'DATABASE_WRITE_FAILED',
      },
    );
  });
});

describe('mobile smoke execution', () => {
  it('distinguishes connection failure and disconnects', async () => {
    const socket = new FakeSocket({ connectError: true });
    const result = await runInfrastructureSmoke(
      'https://server.example',
      () => undefined,
      dependencies(socket),
    );

    assert.equal(result.phase, 'failure');
    if (result.phase === 'failure') {
      assert.equal(result.category, 'connection');
    }
    assert.equal(socket.disconnectCalls, 1);
  });

  it('distinguishes connection timeout', async () => {
    const socket = new FakeSocket({ neverConnect: true });
    const result = await runInfrastructureSmoke(
      'https://server.example',
      () => undefined,
      dependencies(socket, { connectionTimeoutMs: 1 }),
    );

    assert.equal(result.phase, 'failure');
    if (result.phase === 'failure') {
      assert.equal(result.category, 'connection-timeout');
    }
  });

  it('distinguishes acknowledgement timeout', async () => {
    const socket = new FakeSocket({ acknowledgementError: true });
    const result = await runInfrastructureSmoke(
      'https://server.example',
      () => undefined,
      dependencies(socket),
    );

    assert.equal(result.phase, 'failure');
    if (result.phase === 'failure') {
      assert.equal(result.category, 'acknowledgement-timeout');
    }
  });

  it('reports connecting and waiting phases once for one command', async () => {
    const socket = new FakeSocket({ acknowledgement: SUCCESS });
    const phases: string[] = [];
    const result = await runInfrastructureSmoke(
      'https://server.example',
      (phase) => phases.push(phase),
      dependencies(socket),
    );

    assert.equal(result.phase, 'success');
    assert.deepEqual(phases, ['connecting', 'waiting']);
    assert.equal(socket.connectCalls, 1);
    assert.equal(socket.emitCalls, 1);
    assert.equal(socket.disconnectCalls, 1);
  });

  it('returns configuration failure without opening a connection', async () => {
    const socket = new FakeSocket({ acknowledgement: SUCCESS });
    const result = await runInfrastructureSmoke(
      undefined,
      () => undefined,
      dependencies(socket),
    );

    assert.deepEqual(result, {
      phase: 'failure',
      category: 'configuration',
      message: 'Set EXPO_PUBLIC_SERVER_URL to a valid server origin.',
    });
    assert.equal(socket.connectCalls, 0);
  });
});

class FakeSocket {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  emitCalls = 0;
  private readonly listeners = new Map<
    string,
    Set<(...args: never[]) => void>
  >();

  constructor(
    private readonly options: {
      acknowledgement?: unknown;
      acknowledgementError?: boolean;
      connectError?: boolean;
      neverConnect?: boolean;
    },
  ) {}

  connect(): void {
    this.connectCalls += 1;
    if (this.options.neverConnect) {
      return;
    }
    if (this.options.connectError) {
      this.fire('connect_error');
      return;
    }
    this.connected = true;
    this.fire('connect');
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  on(
    event: 'connect' | 'connect_error',
    listener: (...args: never[]) => void,
  ): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(
    event: 'connect' | 'connect_error',
    listener: (...args: never[]) => void,
  ): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  timeout(_milliseconds: number) {
    return {
      emitWithAck: async (): Promise<unknown> => {
        this.emitCalls += 1;
        if (this.options.acknowledgementError) {
          throw new Error('timeout');
        }
        return this.options.acknowledgement;
      },
    };
  }

  private fire(event: 'connect' | 'connect_error'): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}

function dependencies(
  socket: FakeSocket,
  overrides: Partial<RunSmokeDependencies> = {},
): RunSmokeDependencies {
  const identifiers = [COMMAND_ID, PROBE_TOKEN];
  return {
    createIdentifier: () => identifiers.shift() ?? COMMAND_ID,
    createSocket: () => socket,
    connectionTimeoutMs: 50,
    acknowledgementTimeoutMs: 50,
    ...overrides,
  };
}
