const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export type NodeEnvironment = 'development' | 'production' | 'test';

export interface ServerEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly PORT?: string | undefined;
}

export interface ServerConfig {
  readonly host: string;
  readonly nodeEnv?: NodeEnvironment;
  readonly port: number;
}

export function readConfig(
  environment: ServerEnvironment = process.env,
): ServerConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);

  return {
    host: '0.0.0.0',
    port: parsePort(environment.PORT),
    ...(nodeEnv === undefined ? {} : { nodeEnv }),
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
