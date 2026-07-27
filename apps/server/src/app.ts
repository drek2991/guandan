import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';

import type { Database } from './database.js';

const SERVICE_NAME = 'guandan-server';

const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: 'not_found',
  });
};

const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  console.error('Unexpected HTTP error', error);
  response.status(500).json({
    error: 'internal_server_error',
  });
};

export function createApp(database: Pick<Database, 'check'>): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/health', (_request, response) => {
    response.status(200).json({
      status: 'healthy',
      service: SERVICE_NAME,
    });
  });
  app.get('/ready', async (_request, response) => {
    try {
      await database.check();
      response.status(200).json({
        status: 'ready',
        service: SERVICE_NAME,
      });
    } catch {
      response.status(503).json({
        status: 'not_ready',
        service: SERVICE_NAME,
      });
    }
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
