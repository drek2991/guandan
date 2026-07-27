import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig, type QueryResult } from 'pg';

import type { InfrastructureDatabaseSmokeCommand } from '@guandan/protocol';

import type { DatabaseConfig } from './config.js';

const READINESS_QUERY = 'SELECT 1';
export const INFRASTRUCTURE_SMOKE_PROBE_KEY = 'mobile-server-database-v1';

const UPSERT_INFRASTRUCTURE_SMOKE_QUERY = `
  INSERT INTO public.infrastructure_smoke_probe (
    probe_key,
    last_command_id,
    last_probe_token,
    updated_at
  )
  VALUES ($1, $2::uuid, $3::uuid, statement_timestamp())
  ON CONFLICT (probe_key) DO UPDATE SET
    last_command_id = EXCLUDED.last_command_id,
    last_probe_token = EXCLUDED.last_probe_token,
    updated_at = statement_timestamp()
`;

const READ_INFRASTRUCTURE_SMOKE_QUERY = `
  SELECT
    last_command_id::text AS "commandId",
    last_probe_token::text AS "probeToken",
    updated_at AS "databaseUpdatedAt"
  FROM public.infrastructure_smoke_probe
  WHERE probe_key = $1
`;

export interface InfrastructureSmokeDatabaseResult {
  commandId: string;
  probeToken: string;
  databaseUpdatedAt: Date;
}

export type InfrastructureSmokeDatabaseFailure =
  'unavailable' | 'write' | 'readback-mismatch' | 'internal';

export class InfrastructureSmokeDatabaseError extends Error {
  constructor(readonly failure: InfrastructureSmokeDatabaseFailure) {
    super('Infrastructure smoke database operation failed');
    this.name = 'InfrastructureSmokeDatabaseError';
  }
}

export interface Database {
  check(): Promise<void>;
  runInfrastructureSmoke(
    command: InfrastructureDatabaseSmokeCommand,
  ): Promise<InfrastructureSmokeDatabaseResult>;
  close(): Promise<void>;
}

export interface PostgresClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  release(): void;
}

export interface PostgresPool {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type PostgresPoolFactory = (config: PoolConfig) => PostgresPool;
export type CertificateReader = (path: string) => string;

export function createPostgresDatabase(
  config: DatabaseConfig,
  poolFactory: PostgresPoolFactory = createPool,
  certificateReader: CertificateReader = readCertificate,
): Database {
  let pool: PostgresPool;

  try {
    const ca = certificateReader(config.caPath);
    pool = poolFactory({
      application_name: 'guandan-server',
      connectionString: config.connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      max: 5,
      query_timeout: 5_000,
      ssl: {
        ca,
        rejectUnauthorized: true,
      },
      statement_timeout: 5_000,
    });
  } catch {
    throw new Error('Database pool creation failed');
  }

  pool.on('error', () => {
    console.error('Unexpected PostgreSQL pool error');
  });

  let closePromise: Promise<void> | undefined;

  return {
    async check(): Promise<void> {
      try {
        await pool.query(READINESS_QUERY);
      } catch {
        throw new Error('Database readiness check failed');
      }
    },
    async runInfrastructureSmoke(
      command: InfrastructureDatabaseSmokeCommand,
    ): Promise<InfrastructureSmokeDatabaseResult> {
      return runInfrastructureSmoke(pool, command);
    },
    close(): Promise<void> {
      closePromise ??= Promise.resolve().then(() => pool.end());
      return closePromise;
    },
  };
}

async function runInfrastructureSmoke(
  pool: PostgresPool,
  command: InfrastructureDatabaseSmokeCommand,
): Promise<InfrastructureSmokeDatabaseResult> {
  let client: PostgresClient;

  try {
    client = await pool.connect();
  } catch {
    throw new InfrastructureSmokeDatabaseError('unavailable');
  }

  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;

    try {
      await client.query(UPSERT_INFRASTRUCTURE_SMOKE_QUERY, [
        INFRASTRUCTURE_SMOKE_PROBE_KEY,
        command.commandId,
        command.probeToken,
      ]);
    } catch {
      throw new InfrastructureSmokeDatabaseError('write');
    }

    const result = await client.query<InfrastructureSmokeDatabaseResult>(
      READ_INFRASTRUCTURE_SMOKE_QUERY,
      [INFRASTRUCTURE_SMOKE_PROBE_KEY],
    );
    const row = result.rows[0];

    if (
      result.rowCount !== 1 ||
      row === undefined ||
      row.commandId !== command.commandId ||
      row.probeToken !== command.probeToken ||
      !(row.databaseUpdatedAt instanceof Date) ||
      Number.isNaN(row.databaseUpdatedAt.getTime())
    ) {
      throw new InfrastructureSmokeDatabaseError('readback-mismatch');
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return row;
  } catch (error: unknown) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        throw new InfrastructureSmokeDatabaseError('internal');
      }
    }

    if (error instanceof InfrastructureSmokeDatabaseError) {
      throw error;
    }

    throw new InfrastructureSmokeDatabaseError('internal');
  } finally {
    client.release();
  }
}

function createPool(config: PoolConfig): PostgresPool {
  return new Pool(config);
}

function readCertificate(path: string): string {
  return readFileSync(path, 'utf8');
}
