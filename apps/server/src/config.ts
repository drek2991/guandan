import { resolve } from 'node:path';

const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);
const ALLOWED_DATABASE_URL_PARAMETERS = new Set(['sslmode']);

export type NodeEnvironment = 'development' | 'production' | 'test';

export interface ServerEnvironment {
  readonly DATABASE_CA_PATH?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly NODE_ENV?: string | undefined;
  readonly PORT?: string | undefined;
}

export interface DatabaseConfig {
  readonly caPath: string;
  readonly connectionString: string;
}

export interface ServerConfig {
  readonly database: DatabaseConfig;
  readonly host: string;
  readonly nodeEnv?: NodeEnvironment;
  readonly port: number;
}

export function readConfig(
  environment: ServerEnvironment = process.env,
  baseDirectory: string = process.env.INIT_CWD ?? process.cwd(),
): ServerConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);

  return {
    database: parseDatabaseConfig(
      environment.DATABASE_URL,
      environment.DATABASE_CA_PATH,
      baseDirectory,
    ),
    host: '0.0.0.0',
    port: parsePort(environment.PORT),
    ...(nodeEnv === undefined ? {} : { nodeEnv }),
  };
}

function parseDatabaseConfig(
  value: string | undefined,
  caPath: string | undefined,
  baseDirectory: string,
): DatabaseConfig {
  if (value === undefined || value.length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  if (value.trim() !== value) {
    throw new Error('DATABASE_URL must not contain surrounding whitespace');
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'DATABASE_URL must be a valid PostgreSQL URL; percent-encode special characters in credentials',
    );
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      'DATABASE_URL must use the postgres: or postgresql: protocol',
    );
  }

  if (
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.hostname.length === 0 ||
    url.pathname === '/' ||
    url.pathname.length === 0
  ) {
    throw new Error(
      'DATABASE_URL must include a username, password, host, and database name',
    );
  }

  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error(
      'DATABASE_URL credentials contain invalid percent-encoding',
    );
  }

  const sslModes = url.searchParams.getAll('sslmode');

  if (
    sslModes.length > 1 ||
    (sslModes.length === 1 && sslModes[0] !== 'require')
  ) {
    throw new Error(
      'DATABASE_URL sslmode must be absent or appear once with the value require',
    );
  }

  for (const parameter of url.searchParams.keys()) {
    if (!ALLOWED_DATABASE_URL_PARAMETERS.has(parameter)) {
      throw new Error('DATABASE_URL contains unsupported parameters');
    }
  }

  if (caPath === undefined || caPath.length === 0) {
    throw new Error('DATABASE_CA_PATH is required');
  }

  if (caPath.trim() !== caPath) {
    throw new Error('DATABASE_CA_PATH must not contain surrounding whitespace');
  }

  url.searchParams.delete('sslmode');

  return {
    caPath: resolve(baseDirectory, caPath),
    connectionString: url.href,
  };
}

function parseNodeEnvironment(
  value: string | undefined,
): NodeEnvironment | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case 'development':
    case 'production':
    case 'test':
      return value;
    default:
      throw new Error('NODE_ENV must be development, production, or test');
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `PORT must be an integer between ${MIN_PORT} and ${MAX_PORT}`,
    );
  }

  return port;
}
