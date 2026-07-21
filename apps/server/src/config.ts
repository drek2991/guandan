const DEFAULT_PORT = 3000;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface ServerConfig {
  host: string;
  port: number;
}

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return {
    host: '0.0.0.0',
    port: parsePort(environment.PORT),
  };
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
