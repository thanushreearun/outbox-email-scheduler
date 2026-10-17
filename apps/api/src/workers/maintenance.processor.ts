import type { Job } from 'bullmq';
import type { Client } from '@elastic/elasticsearch';
import type { Logger } from '../lib/logger.js';
import type { OutboxReconciler } from '../queue/reconciler.js';
import type { MaintenanceJobName } from '../queue/queues.js';
import { ensureEmailIndex } from '../modules/search/search.client.js';
import type { SearchIndexer } from '../modules/search/search.indexer.js';
import type { RateLimitNotifier } from '../modules/slack/rate-limit-notifier.js';
import type { SessionService } from '../modules/auth/session.service.js';

/**
 * Housekeeping run by BullMQ job schedulers with fixed `every` intervals. The schedule
 * lives in Redis, so there is one run per interval no matter how many workers are up.
 */
export function createMaintenanceProcessor(deps: {
  reconciler: OutboxReconciler;
  indexer: SearchIndexer;
  notifier: RateLimitNotifier;
  sessions: Pick<SessionService, 'purgeExpired'>;
  es: Client;
  logger: Logger;
}) {
  return async (job: Job<Record<string, never>, unknown, MaintenanceJobName>) => {
    switch (job.name) {
      case 'reconcile-outbox': {
        const enqueued = await deps.reconciler.enqueuePending();
        // Only rows untouched for 15 minutes: active work is not second-guessed.
        const verified = await deps.reconciler.verifyJobs({ olderThanMs: 15 * 60_000 });
        return { enqueued, ...verified };
      }
      case 'reindex-search': {
        if (!(await ensureEmailIndex(deps.es, deps.logger))) return { indexed: 0, available: false };
        let indexed = 0;
        for (let round = 0; round < 20; round++) {
          const n = await deps.indexer.reconcile(500);
          indexed += n;
          if (n < 500) break;
        }
        return { indexed };
      }
      case 'retry-notifications':
        return { sent: await deps.notifier.retryPending() };
      case 'purge-expired':
        return deps.sessions.purgeExpired();
      default:
        deps.logger.warn({ name: job.name }, 'unknown maintenance job');
        return null;
    }
  };
}
