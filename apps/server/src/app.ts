import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';

const SERVICE_NAME = 'guandan-server';

const notFoundHandler: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: 'not_found',
  });
};

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error('Unexpected HTTP error', error);
  response.status(500).json({
    error: 'internal_server_error',
  });
};

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/health', (_request, response) => {
    response.status(200).json({
      status: 'healthy',
      service: SERVICE_NAME,
    });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
