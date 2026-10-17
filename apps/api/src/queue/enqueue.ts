import type { Queue } from 'bullmq';
import type { Db } from '../lib/prisma.js';
import type { Logger } from '../lib/logger.js';
import { emailJobId, emailJobOptions, type EmailJobData } from './queues.js';

export interface EnqueueTarget {
  id: string;
  scheduledAt: Date;
  deferredUntil: Date | null;
}

const CHUNK = 500;

/**
 * Second half of the transactional-outbox write. Rows are already committed with
 * `enqueuedAt = NULL`; here we add their delayed jobs and then stamp `enqueuedAt`.
 *
 * - Deterministic job IDs make this idempotent: adding an existing job ID is a no-op.
 * - If Redis is down, rows stay `enqueuedAt = NULL` and the reconciler retries later.
 * - The delay is recomputed from the persisted timestamp, so re-enqueueing after a crash
 *   never shifts the scheduled time.
 */
export async function enqueueEmails(
  deps: { db: Db; queue: Queue<EmailJobData>; logger: Logger },
  emails: EnqueueTarget[],
): Promise<{ enqueued: number; failed: number }> {
  let enqueued = 0;
  let failed = 0;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const now = Date.now();
    try {
      await deps.queue.addBulk(
        chunk.map((e) => {
          const runAt = Math.max(e.scheduledAt.getTime(), e.deferredUntil?.getTime() ?? 0);
          return {
            name: 'send',
            data: { emailId: e.id },
            opts: { ...emailJobOptions(), jobId: emailJobId(e.id), delay: Math.max(0, runAt - now) },
          };
        }),
      );
      await deps.db.email.updateMany({
        where: { id: { in: chunk.map((e) => e.id) }, enqueuedAt: null },
        data: { enqueuedAt: new Date() },
      });
      enqueued += chunk.length;
    } catch (err) {
      failed += chunk.length;
      deps.logger.error(
        { err: (err as Error).message, count: chunk.length },
        'enqueue failed; rows left for outbox reconciliation',
      );
    }
  }
  return { enqueued, failed };
}
