import { pino } from 'pino';
import { config, env } from '../config/env.js';

/**
 * Structured JSON logger. Redaction is a safety net; code must still avoid logging
 * secrets and email bodies in the first place.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: process.env.SERVICE_NAME ?? (/worker\.[jt]s$/.test(process.argv[1] ?? '') ? 'worker' : 'api'),
  },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.pass',
      '*.token',
      '*.accessToken',
      '*.botToken',
      '*.webhookUrl',
      '*.bodyHtml',
      '*.bodyText',
    ],
    censor: '[redacted]',
  },
  transport:
    !config.isProd && !config.isTest && process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
      : undefined,
});

export type Logger = typeof logger;
