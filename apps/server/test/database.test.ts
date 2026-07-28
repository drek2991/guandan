import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PoolConfig, QueryResult } from 'pg';

import {
  INFRASTRUCTURE_SMOKE_PROBE_KEY,
  InfrastructureSmokeDatabaseError,
  createPostgresDatabase,
  type PostgresClient,
  type PostgresPool,
} from '../src/database.js';

const CONNECTION_STRING = 'database-configuration-fixture';
const RAW_ERROR_MARKER = 'raw-database-error-marker';
const COMMAND = {
  commandId: '550e8400-e29b-41d4-a716-446655440000',
  probeToken: '8f14e45f-ea1e-4b29-bad7-6e7f5f541234',
};
const DATABASE_UPDATED_AT = new Date('2026-07-27T12:00:00.000Z');

describe('PostgreSQL database boundary', () => {
  it('constructs a bounded pool and verifies connectivity', async () => {
    let receivedConfig: PoolConfig | undefined;
    const queries: QueryCall[] = [];
    const pool = createFakePool({ queries });
    const database = createPostgresDatabase(
      { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
      (config) => {
        receivedConfig = config;
        return pool;
      },
      () => 'test-ca-contents',
    );

    await database.check();

    assert.deepEqual(receivedConfig, {
      application_name: 'guandan-server',
      connectionString: CONNECTION_STRING,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 5,
      query_timeout: 5_000,
      ssl: {
        ca: 'test-ca-contents',
        rejectUnauthorized: true,
      },
      statement_timeout: 5_000,
    });
    assert.deepEqual(queries, [{ text: 'SELECT 1', values: undefined }]);
  });

  it('sanitizes readiness failures', async () => {
    const database = createPostgresDatabase(
      { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
      () =>
        createFakePool({
          queryError: new Error(RAW_ERROR_MARKER),
        }),
      () => 'test-ca-contents',
    );

    await assert.rejects(database.check(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Database readiness check failed');
      assert.equal(error.message.includes(RAW_ERROR_MARKER), false);
      return true;
    });
  });

  it('registers an idle pool error listener', () => {
    let registeredErrorListener = false;

    createPostgresDatabase(
      { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
      () =>
        createFakePool({
          onErrorListener: () => {
            registeredErrorListener = true;
          },
        }),
      () => 'test-ca-contents',
    );

    assert.equal(registeredErrorListener, true);
  });

  it('runs the fixed-key upsert and matching readback in one transaction', async () => {
    const queries: QueryCall[] = [];
    let releases = 0;
    const database = createDatabaseWithClient({
      queries,
      onRelease: () => {
        releases += 1;
      },
    });

    const result = await database.runInfrastructureSmoke(COMMAND);

    assert.deepEqual(result, {
      ...COMMAND,
      databaseUpdatedAt: DATABASE_UPDATED_AT,
    });
    assert.equal(queries.length, 4);
    assert.equal(queries[0]?.text, 'BEGIN');
    assert.match(
      queries[1]?.text ?? '',
      /INSERT INTO public\.infrastructure_smoke_probe/,
    );
    assert.match(queries[1]?.text ?? '', /ON CONFLICT \(probe_key\) DO UPDATE/);
    assert.deepEqual(queries[1]?.values, [
      INFRASTRUCTURE_SMOKE_PROBE_KEY,
      COMMAND.commandId,
      COMMAND.probeToken,
    ]);
    assert.match(
      queries[2]?.text ?? '',
      /FROM public\.infrastructure_smoke_probe/,
    );
    assert.deepEqual(queries[2]?.values, [INFRASTRUCTURE_SMOKE_PROBE_KEY]);
    assert.equal(queries[3]?.text, 'COMMIT');
    assert.equal(releases, 1);
  });

  it('returns unavailable when a transaction client cannot be acquired', async () => {
    const database = createPostgresDatabase(
      { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
      () => createFakePool({ connectError: new Error(RAW_ERROR_MARKER) }),
      () => 'test-ca-contents',
    );

    await assertSmokeFailure(
      database.runInfrastructureSmoke(COMMAND),
      'unavailable',
    );
  });

  it('rolls back and returns write failure when the upsert fails', async () => {
    const queries: QueryCall[] = [];
    let releases = 0;
    const database = createDatabaseWithClient({
      queries,
      onRelease: () => {
        releases += 1;
      },
      clientQueryError: (text) =>
        text.includes('INSERT INTO') ? new Error(RAW_ERROR_MARKER) : undefined,
    });

    await assertSmokeFailure(database.runInfrastructureSmoke(COMMAND), 'write');
    assert.deepEqual(
      queries.map(({ text }) => transactionLabel(text)),
      ['BEGIN', 'UPSERT', 'ROLLBACK'],
    );
    assert.equal(releases, 1);
  });

  it('rolls back when the database readback does not match', async () => {
    const queries: QueryCall[] = [];
    const database = createDatabaseWithClient({
      queries,
      readback: {
        ...COMMAND,
        probeToken: 'a8098c1a-f86e-4b3a-b53f-74a0f9e8d123',
        databaseUpdatedAt: DATABASE_UPDATED_AT,
      },
    });

    await assertSmokeFailure(
      database.runInfrastructureSmoke(COMMAND),
      'readback-mismatch',
    );
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    assert.equal(
      queries.some(({ text }) => text === 'COMMIT'),
      false,
    );
  });

  it('rolls back and returns internal error for read query execution failures', async () => {
    const queries: QueryCall[] = [];
    const database = createDatabaseWithClient({
      queries,
      clientQueryError: (text) =>
        text.includes('SELECT') ? new Error(RAW_ERROR_MARKER) : undefined,
    });

    await assertSmokeFailure(
      database.runInfrastructureSmoke(COMMAND),
      'internal',
    );
    assert.equal(queries.at(-1)?.text, 'ROLLBACK');
  });

  for (const [name, readback] of [
    ['missing row', null],
    ['malformed timestamp', { ...COMMAND, databaseUpdatedAt: 'not-a-date' }],
  ] as const) {
    it(`rolls back with readback mismatch for ${name}`, async () => {
      const queries: QueryCall[] = [];
      const database = createDatabaseWithClient({ queries, readback });

      await assertSmokeFailure(
        database.runInfrastructureSmoke(COMMAND),
        'readback-mismatch',
      );
      assert.equal(queries.at(-1)?.text, 'ROLLBACK');
    });
  }

  it('returns success only after commit succeeds', async () => {
    const queries: QueryCall[] = [];
    const database = createDatabaseWithClient({
      queries,
      clientQueryError: (text) =>
        text === 'COMMIT' ? new Error(RAW_ERROR_MARKER) : undefined,
    });

    await assertSmokeFailure(
      database.runInfrastructureSmoke(COMMAND),
      'internal',
    );
    assert.deepEqual(
      queries.map(({ text }) => transactionLabel(text)),
      ['BEGIN', 'UPSERT', 'READBACK', 'COMMIT', 'ROLLBACK'],
    );
  });

  it('returns internal error when rollback fails', async () => {
    const queries: QueryCall[] = [];
    const database = createDatabaseWithClient({
      queries,
      clientQueryError: (text) => {
        if (text.includes('INSERT INTO') || text === 'ROLLBACK') {
          return new Error(RAW_ERROR_MARKER);
        }
        return undefined;
      },
    });

    await assertSmokeFailure(
      database.runInfrastructureSmoke(COMMAND),
      'internal',
    );
    assert.deepEqual(
      queries.map(({ text }) => transactionLabel(text)),
      ['BEGIN', 'UPSERT', 'ROLLBACK'],
    );
  });

  it('repeated requests use the same logical key and upsert path', async () => {
    const queries: QueryCall[] = [];
    const database = createDatabaseWithClient({ queries });

    await database.runInfrastructureSmoke(COMMAND);
    await database.runInfrastructureSmoke(COMMAND);

    const upserts = queries.filter(({ text }) => text.includes('INSERT INTO'));
    assert.equal(upserts.length, 2);
    assert.equal(
      upserts.every(
        ({ text, values }) =>
          text.includes('ON CONFLICT (probe_key) DO UPDATE') &&
          values?.[0] === INFRASTRUCTURE_SMOKE_PROBE_KEY,
      ),
      true,
    );
  });

  it('closes the pool once across repeated and concurrent calls', async () => {
    let endCalls = 0;
    const database = createPostgresDatabase(
      { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
      () =>
        createFakePool({
          onEnd: () => {
            endCalls += 1;
          },
        }),
      () => 'test-ca-contents',
    );

    const firstClose = database.close();
    const secondClose = database.close();

    assert.equal(firstClose, secondClose);
    await Promise.all([firstClose, secondClose]);
    await database.close();
    assert.equal(endCalls, 1);
  });

  it('sanitizes synchronous pool-construction failures', () => {
    assert.throws(
      () =>
        createPostgresDatabase(
          { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
          () => {
            throw new Error(RAW_ERROR_MARKER);
          },
          () => 'test-ca-contents',
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Database pool creation failed');
        assert.equal(error.message.includes(RAW_ERROR_MARKER), false);
        return true;
      },
    );
  });
});

interface QueryCall {
  text: string;
  values: readonly unknown[] | undefined;
}

interface FakePoolOptions {
  connectError?: Error;
  client?: PostgresClient;
  onEnd?: () => void;
  onErrorListener?: () => void;
  queries?: QueryCall[];
  queryError?: Error;
}

function createFakePool(options: FakePoolOptions = {}): PostgresPool {
  return {
    async query<R extends object>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      options.queries?.push({ text, values });
      if (options.queryError !== undefined) {
        throw options.queryError;
      }
      return queryResult<R>([]);
    },
    async connect(): Promise<PostgresClient> {
      if (options.connectError !== undefined) {
        throw options.connectError;
      }
      return options.client ?? createFakeClient();
    },
    async end(): Promise<void> {
      options.onEnd?.();
    },
    on(event: 'error', _listener: (error: Error) => void): PostgresPool {
      assert.equal(event, 'error');
      options.onErrorListener?.();
      return this;
    },
  };
}

function createDatabaseWithClient(options: {
  clientQueryError?: (text: string) => Error | undefined;
  onRelease?: () => void;
  queries: QueryCall[];
  readback?: {
    commandId: string;
    probeToken: string;
    databaseUpdatedAt: Date | string;
  } | null;
}) {
  const client = createFakeClient(options);
  return createPostgresDatabase(
    { caPath: 'test-ca.crt', connectionString: CONNECTION_STRING },
    () => createFakePool({ client }),
    () => 'test-ca-contents',
  );
}

function createFakeClient(options?: {
  clientQueryError?: (text: string) => Error | undefined;
  onRelease?: () => void;
  queries?: QueryCall[];
  readback?: {
    commandId: string;
    probeToken: string;
    databaseUpdatedAt: Date | string;
  } | null;
}): PostgresClient {
  return {
    async query<R extends object>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      options?.queries?.push({ text, values });
      const error = options?.clientQueryError?.(text);
      if (error !== undefined) {
        throw error;
      }

      if (text.includes('SELECT')) {
        if (options?.readback === null) {
          return queryResult<R>([]);
        }

        const readback = options?.readback ?? {
          ...COMMAND,
          databaseUpdatedAt: DATABASE_UPDATED_AT,
        };
        return queryResult([readback as R]);
      }

      return queryResult<R>([]);
    },
    release(): void {
      options?.onRelease?.();
    },
  };
}

function queryResult<R extends object>(rows: R[]): QueryResult<R> {
  return {
    command: '',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
}

function transactionLabel(text: string): string {
  if (text.includes('INSERT INTO')) {
    return 'UPSERT';
  }
  if (text.includes('SELECT')) {
    return 'READBACK';
  }
  return text;
}

async function assertSmokeFailure(
  promise: Promise<unknown>,
  failure: InfrastructureSmokeDatabaseError['failure'],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof InfrastructureSmokeDatabaseError);
    assert.equal(error.failure, failure);
    assert.equal(error.message.includes(RAW_ERROR_MARKER), false);
    return true;
  });
}
