import type { Queue } from 'bullmq';
import type { Db } from '../lib/prisma.js';
import type { Logger } from '../lib/logger.js';
import { PENDING_STATUSES } from '../modules/emails/status.js';
import { enqueueEmails } from './enqueue.js';
import { emailJobId, type EmailJobData } from './queues.js';

/**
 * Keeps Redis (derived) consistent with PostgreSQL (authoritative) without cron:
 *
 * - `enqueuePending` finishes outbox writes whose enqueue step never happened
 *   (API crashed or Redis was down between COMMIT and addBulk).
 * - `verifyJobs` walks non-terminal rows and repairs their jobs: re-adds missing jobs
 *   (e.g. Redis data loss), and replaces jobs BullMQ marked failed or completed while the
 *   row is still pending (crash between DB write and throw, stalled-limit exceeded).
 *   Re-added jobs take their delay from the stored schedule, so nothing runs early.
 *
 * Both are idempotent and safe to run concurrently with workers, because the processor
 * itself is idempotent and job IDs are deterministic.
 */
export class OutboxReconciler {
  constructor(private readonly deps: { db: Db; queue: Queue<EmailJobData>; logger: Logger }) {}

  async enqueuePending(graceMs = 10_000): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.deps.db.email.findMany({
        where: {
          enqueuedAt: null,
          status: { in: [...PENDING_STATUSES] },
          createdAt: { lt: new Date(Date.now() - graceMs) },
        },
        select: { id: true, scheduledAt: true, deferredUntil: true },
        orderBy: { scheduledAt: 'asc' },
        take: 1000,
      });
      if (rows.length === 0) break;
      const { enqueued } = await enqueueEmails(this.deps, rows);
      total += enqueued;
      if (enqueued < rows.length) break; // Redis still failing; try next cycle.
    }
    if (total > 0) this.deps.logger.info({ total }, 'outbox: enqueued pending rows');
    return total;
  }

  async verifyJobs(opts: { olderThanMs?: number } = {}): Promise<{ checked: number; repaired: number }> {
    let cursor: string | undefined;
    let checked = 0;
    let repaired = 0;
    const updatedBefore = opts.olderThanMs ? new Date(Date.now() - opts.olderThanMs) : undefined;

    for (;;) {
      const rows = await this.deps.db.email.findMany({
        where: {
          status: { in: [...PENDING_STATUSES] },
          enqueuedAt: { not: null },
          ...(updatedBefore ? { updatedAt: { lt: updatedBefore } } : {}),
        },
        select: { id: true, scheduledAt: true, deferredUntil: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.id;
      checked += rows.length;

      const states = await Promise.all(rows.map((r) => this.deps.queue.getJobState(emailJobId(r.id))));
      const missing: typeof rows = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const state = states[i];
        if (state === 'unknown') {
          missing.push(row);
        } else if (state === 'failed' || state === 'completed') {
          // Replace rather than `job.retry()`: a retried job runs immediately, while a
          // re-added one gets its delay recomputed from the persisted schedule.
          const job = await this.deps.queue.getJob(emailJobId(row.id));
          await job?.remove();
          missing.push(row);
        }
      }
      if (missing.length > 0) {
        const { enqueued } = await enqueueEmails(this.deps, missing);
        repaired += enqueued;
      }
    }
    if (repaired > 0) this.deps.logger.warn({ checked, repaired }, 'outbox: repaired queue jobs');
    return { checked, repaired };
  }
}
