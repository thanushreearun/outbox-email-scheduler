import { config, env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { sharedRedis } from './lib/redis.js';
import { NodemailerMailer } from './integrations/mailer.js';
import { createQueues } from './queue/queues.js';
import { HourlyQuota } from './queue/rate-limiter.js';
import { OutboxReconciler } from './queue/reconciler.js';
import { createSearchClient } from './modules/search/search.client.js';
import { SearchIndexer } from './modules/search/search.indexer.js';
import { SearchService } from './modules/search/search.service.js';
import { SlackClient } from './modules/slack/slack.client.js';
import { RateLimitNotifier } from './modules/slack/rate-limit-notifier.js';

/**
 * Composition root. Modules receive their collaborators explicitly (constructor/function
 * arguments) so tests can substitute fakes; this file wires the real implementations.
 */
export function createContainer() {
  const redis = sharedRedis();
  const queues = createQueues(redis);
  const es = createSearchClient();
  const slack = config.slack ? new SlackClient(config.slack) : null;
  const indexer = new SearchIndexer({ db: prisma, es, logger });
  return {
    db: prisma,
    logger,
    redis,
    queues,
    es,
    slack,
    mailer: new NodemailerMailer(),
    indexer,
    search: new SearchService({ es, db: prisma, logger }),
    quota: new HourlyQuota(redis, { prefix: env.QUEUE_PREFIX, windowMs: env.RATE_LIMIT_WINDOW_MS }),
    notifier: new RateLimitNotifier({ db: prisma, logger, slack }),
    reconciler: new OutboxReconciler({ db: prisma, queue: queues.email, logger }),
  };
}

export type Container = ReturnType<typeof createContainer>;
