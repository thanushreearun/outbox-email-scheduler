import { createApp } from './app.js';
import { config, env } from './config/env.js';
import { createContainer } from './container.js';
import { closeSharedRedis } from './lib/redis.js';
import { closeQueues } from './queue/queues.js';
import { ensureEmailIndex } from './modules/search/search.client.js';

/**
 * API process: serves HTTP and produces queue jobs. It never consumes jobs; run
 * `npm run dev:worker` (or `start:worker`) for that. Both can be restarted independently.
 */
const c = createContainer();
const app = createApp(c);

const server = app.listen(env.PORT, () => {
  c.logger.info(
    {
      port: env.PORT,
      google: Boolean(config.google),
      slack: Boolean(config.slack),
      ethereal: Boolean(config.ethereal),
      admins: config.adminEmails.size,
    },
    'api listening',
  );
  void ensureEmailIndex(c.es, c.logger);
  // Finish any outbox writes interrupted by a previous crash of this process.
  void c.reconciler
    .enqueuePending(0)
    .catch((err: Error) => c.logger.warn({ err: err.message }, 'startup enqueue failed'));
});
server.keepAliveTimeout = 65_000;

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  c.logger.info({ signal }, 'api shutting down');
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeQueues(c.queues);
  c.mailer.close();
  await Promise.allSettled([c.db.$disconnect(), c.es.close(), closeSharedRedis()]);
  c.logger.info('api stopped');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => c.logger.error({ reason }, 'unhandled rejection'));
