import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { config, env } from './config/env.js';
import type { Container } from './container.js';
import { openApiDocument } from './docs/openapi.js';
import { loadSession, requireAdmin, requireAuth } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { BULL_BOARD_PATH, bullBoardRouter, queueStatsRouter } from './modules/admin/queue.routes.js';
import { attachmentsRouter } from './modules/attachments/attachments.routes.js';
import { authRouter, meHandler } from './modules/auth/auth.routes.js';
import { GoogleAuthService } from './modules/auth/google.service.js';
import { SessionService } from './modules/auth/session.service.js';
import { EmailService } from './modules/emails/email.service.js';
import { emailsRouter } from './modules/emails/emails.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { SenderService } from './modules/senders/sender.service.js';
import { sendersRouter } from './modules/senders/senders.routes.js';
import { slackEventsHandler, slackRouter } from './modules/slack/slack.routes.js';

export function createApp(c: Container) {
  const sessions = new SessionService(c.db);
  const senders = new SenderService({ db: c.db, mailer: c.mailer });
  const google = config.google ? new GoogleAuthService(c.db, config.google) : null;
  const emails = new EmailService({
    db: c.db,
    queue: c.queues.email,
    logger: c.logger,
    indexer: c.indexer,
    quota: c.quota,
    senders,
  });

  const app = express();
  app.disable('x-powered-by');
  // The Vite dev server / a reverse proxy sits in front of the API.
  app.set('trust proxy', config.isProd ? 1 : 'loopback');

  app.use(
    pinoHttp({
      logger: c.logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
      customProps: (req) => ({ userId: (req as Request).auth?.user.id }),
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // CORS for the known frontend origin only (in dev the Vite proxy makes requests same-origin).
  const frontendOrigin = new URL(env.FRONTEND_URL).origin;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.origin === frontendOrigin) {
      res.setHeader('Access-Control-Allow-Origin', frontendOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'content-type,x-csrf-token,idempotency-key');
        res.setHeader('Access-Control-Max-Age', '600');
        return res.status(204).end();
      }
    }
    next();
  });

  // Slack Events need the raw body for signature verification: mount before JSON parsing.
  app.post('/api/slack/events', ...slackEventsHandler(c.db));

  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(loadSession(sessions));

  // UIs with their own scripts get a relaxed CSP; everything else gets helmet's strict default.
  const relaxed = helmet({ contentSecurityPolicy: false });
  app.use(BULL_BOARD_PATH, relaxed, requireAuth, requireAdmin, bullBoardRouter(c.queues));
  app.get('/api/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use(
    '/api/docs',
    relaxed,
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, { customSiteTitle: 'Outbox API' }),
  );

  app.use(helmet());
  app.use(csrfProtection);

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.method === 'GET',
    keyGenerator: (req) => req.auth?.user.id ?? ipKeyGenerator(req.ip ?? '0.0.0.0'),
  });

  app.use('/api/health', healthRouter({ db: c.db, redis: c.redis, es: c.es }));
  app.get('/api/config', (_req, res) => {
    res.json({
      data: {
        minDelayBetweenEmailsMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
        maxEmailsPerHourPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        maxEmailsPerHourGlobal: env.MAX_EMAILS_PER_HOUR_GLOBAL,
        maxRecipientsPerBatch: env.MAX_RECIPIENTS_PER_BATCH,
        maxAttachmentBytes: env.MAX_ATTACHMENT_BYTES,
        googleConfigured: Boolean(config.google),
        slackConfigured: Boolean(config.slack),
        etherealConfigured: Boolean(config.ethereal),
      },
    });
  });
  app.use('/api/auth', authLimiter, authRouter({ db: c.db, google, sessions, senders }));
  app.get('/api/me', requireAuth, meHandler);
  app.use('/api/slack', slackRouter({ db: c.db, slack: c.slack }));
  app.use('/api/senders', requireAuth, writeLimiter, sendersRouter(senders));
  app.use('/api/emails', requireAuth, writeLimiter, emailsRouter({ emails, search: c.search }));
  app.use('/api/attachments', requireAuth, writeLimiter, attachmentsRouter(c.db));
  app.use('/api/queue', requireAuth, queueStatsRouter({ queues: c.queues, emails }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
