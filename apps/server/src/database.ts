import { readFileSync } from 'node:fs';

import { Pool, type PoolConfig } from 'pg';

import type { DatabaseConfig } from './config.js';

const READINESS_QUERY = 'SELECT 1';

export interface Database {
  check(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresPool {
  query(text: string): Promise<unknown>;
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
    close(): Promise<void> {
      closePromise ??= Promise.resolve().then(() => pool.end());
      return closePromise;
    },
  };
}

function createPool(config: PoolConfig): PostgresPool {
  return new Pool(config);
}

function readCertificate(path: string): string {
  return readFileSync(path, 'utf8');
}
