import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';

export const EMAIL_QUEUE = 'email-send';
export const MAINTENANCE_QUEUE = 'maintenance';

export interface EmailJobData {
  /** Only the database ID travels through Redis: no recipient data or content. */
  emailId: string;
}

export type MaintenanceJobName =
  'reconcile-outbox' | 'reindex-search' | 'retry-notifications' | 'purge-expired';

/**
 * BullMQ custom job IDs must not contain ':' and must not be purely numeric.
 * The ID is derived from the immutable DB primary key, so re-adding the same email is a
 * no-op while the job exists (deduplication across API retries and reconciliation).
 */
export function emailJobId(emailId: string): string {
  return `email_${emailId}`;
}

export const emailJobOptions = (): JobsOptions => ({
  attempts: env.EMAIL_MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: env.EMAIL_BACKOFF_MS },
  // Keep history bounded but long enough to debug from the dashboard.
  removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
});

export interface Queues {
  email: Queue<EmailJobData>;
  maintenance: Queue<Record<string, never>, unknown, MaintenanceJobName>;
}

export function createQueues(connection: Redis): Queues {
  const prefix = env.QUEUE_PREFIX;
  return {
    email: new Queue<EmailJobData>(EMAIL_QUEUE, { connection, prefix }),
    maintenance: new Queue<Record<string, never>, unknown, MaintenanceJobName>(MAINTENANCE_QUEUE, {
      connection,
      prefix,
    }),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.allSettled([queues.email.close(), queues.maintenance.close()]);
}
