import { readConfig } from './config.js';
import { registerShutdownHandlers, startServer } from './start.js';

async function main(): Promise<void> {
  const config = readConfig();
  const runningServer = await startServer(config);

  registerShutdownHandlers(runningServer);
  console.log(
    `Guandan server listening on ${config.host}:${runningServer.address.port}`,
  );
}

main().catch((error: unknown) => {
  console.error('Server startup failed', error);
  process.exitCode = 1;
});
