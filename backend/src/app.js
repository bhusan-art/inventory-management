import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import env from './config/env.js';
import logger from './config/logger.js';
import requestContext from './middleware/requestContext.js';
import errorHandler from './middleware/errorHandler.js';
import notFound from './middleware/notFound.js';
import v1Routes from './routes/v1/index.js';

export function createApp() {
  const app = express();

  // Behind nginx. Required for req.ip and rate limiting to see the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests carry no Origin header.
        if (!origin || env.clientOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true, // refresh token travels as an HttpOnly cookie
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestContext);

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => req.context?.requestId,
        autoLogging: { ignore: (req) => req.url.startsWith('/api/v1/health') },
      }),
    );
  }

  // Global ceiling. Tighter per-route limits are added in Phase 1 on the auth
  // endpoints, where the threat is credential stuffing rather than volume.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: env.isTest ? 100_000 : 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { success: false, message: 'Too many requests', errors: [{ code: 'RATE_LIMITED' }] },
    }),
  );

  app.use('/api/v1', v1Routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
