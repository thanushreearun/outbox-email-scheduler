import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { createContainer } from './container.js';
import { closeSharedRedis, createRedis } from './lib/redis.js';
import { EMAIL_QUEUE, MAINTENANCE_QUEUE, closeQueues, type EmailJobData } from './queue/queues.js';
import { SendSpacer } from './queue/spacing.js';
import { SessionService } from './modules/auth/session.service.js';
import { ensureEmailIndex } from './modules/search/search.client.js';
import { createEmailProcessor } from './workers/email.processor.js';
import { createMaintenanceProcessor } from './workers/maintenance.processor.js';

/**
 * Worker process: consumes the email queue and runs maintenance. Can be scaled
 * horizontally; all coordination (claims, quota, spacing, scheduling) is shared through
 * PostgreSQL and Redis, never process memory.
 */
const c = createContainer();
const log = c.logger;

const emailWorker = new Worker<EmailJobData>(
  EMAIL_QUEUE,
  createEmailProcessor({
    db: c.db,
    logger: log,
    quota: c.quota,
    spacer: new SendSpacer(c.redis, env.QUEUE_PREFIX),
    mailer: c.mailer,
    indexer: c.indexer,
    notifier: c.notifier,
    settings: {
      senderHourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      globalHourlyLimit: env.MAX_EMAILS_PER_HOUR_GLOBAL,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      uploadDir: env.UPLOAD_DIR,
      messageIdDomain: new URL(env.FRONTEND_URL).hostname || 'outbox.local',
    },
  }),
  {
    connection: createRedis('email-worker'),
    prefix: env.QUEUE_PREFIX,
    concurrency: env.WORKER_CONCURRENCY,
    // Locks are renewed automatically while a job waits for its spacing slot.
    lockDuration: 60_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  },
);

const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE,
  createMaintenanceProcessor({
    reconciler: c.reconciler,
    indexer: c.indexer,
    notifier: c.notifier,
    sessions: new SessionService(c.db),
    es: c.es,
    logger: log,
  }),
  { connection: createRedis('maintenance-worker'), prefix: env.QUEUE_PREFIX, concurrency: 1 },
);

emailWorker.on('failed', (job, err) =>
  log.warn({ jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'email job failed'),
);
emailWorker.on('error', (err) => log.error({ err: err.message }, 'email worker error'));
maintenanceWorker.on('failed', (job, err) =>
  log.warn({ job: job?.name, err: err.message }, 'maintenance job failed'),
);

async function startup() {
  await ensureEmailIndex(c.es, log);
  // Interval schedulers are upserted (idempotent across restarts and replicas).
  const every = env.RECONCILE_INTERVAL_MS;
  await c.queues.maintenance.upsertJobScheduler('reconcile-outbox', { every }, { name: 'reconcile-outbox' });
  await c.queues.maintenance.upsertJobScheduler('reindex-search', { every }, { name: 'reindex-search' });
  await c.queues.maintenance.upsertJobScheduler(
    'retry-notifications',
    { every: Math.max(every, 60_000) },
    {
      name: 'retry-notifications',
    },
  );
  await c.queues.maintenance.upsertJobScheduler(
    'purge-expired',
    { every: 3_600_000 },
    { name: 'purge-expired' },
  );

  // Full startup recovery: finish interrupted outbox writes and verify every pending job.
  const enqueued = await c.reconciler.enqueuePending(0);
  const verified = await c.reconciler.verifyJobs();
  log.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      perSenderHourly: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      globalHourly: env.MAX_EMAILS_PER_HOUR_GLOBAL,
      recovery: { enqueued, ...verified },
    },
    'worker started',
  );
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'worker shutting down; waiting for active jobs');
  const force = setTimeout(() => {
    log.error('graceful shutdown timed out');
    process.exit(1);
  }, 60_000);
  force.unref();
  await Promise.allSettled([emailWorker.close(), maintenanceWorker.close()]);
  await closeQueues(c.queues);
  c.mailer.close();
  await Promise.allSettled([c.db.$disconnect(), c.es.close(), closeSharedRedis()]);
  log.info('worker stopped');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

startup().catch((err: Error) => {
  log.error({ err: err.message }, 'worker startup failed');
  process.exit(1);
});
