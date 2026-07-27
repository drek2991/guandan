import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PoolConfig } from 'pg';

import { createPostgresDatabase, type PostgresPool } from '../src/database.js';

const CONNECTION_STRING = 'database-configuration-fixture';
const RAW_ERROR_MARKER = 'raw-database-error-marker';

describe('PostgreSQL database boundary', () => {
  it('constructs a bounded pool and verifies connectivity', async () => {
    let receivedConfig: PoolConfig | undefined;
    const queries: string[] = [];
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
    assert.deepEqual(queries, ['SELECT 1']);
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

interface FakePoolOptions {
  onEnd?: () => void;
  onErrorListener?: () => void;
  queries?: string[];
  queryError?: Error;
}

function createFakePool(options: FakePoolOptions = {}): PostgresPool {
  return {
    async query(text: string): Promise<unknown> {
      options.queries?.push(text);
      if (options.queryError !== undefined) {
        throw options.queryError;
      }
      return undefined;
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
