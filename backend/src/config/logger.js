import pino from 'pino';
import env from './env.js';

/**
 * Redaction is configured here rather than at call sites. A logger that depends
 * on every developer remembering not to log a password will eventually log one.
 */
const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.token',
    ],
    censor: '[redacted]',
  },
  transport: env.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});

export default logger;
