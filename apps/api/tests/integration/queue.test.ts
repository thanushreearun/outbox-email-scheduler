import { UnrecoverableError, Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { SmtpError } from '../../src/integrations/mailer.js';
import { logger } from '../../src/lib/logger.js';
import { closeSharedRedis, createRedis, sharedRedis } from '../../src/lib/redis.js';
import { enqueueEmails } from '../../src/queue/enqueue.js';
import {
  closeQueues,
  createQueues,
  EMAIL_QUEUE,
  emailJobId,
  type EmailJobData,
} from '../../src/queue/queues.js';
import { HourlyQuota } from '../../src/queue/rate-limiter.js';
import { OutboxReconciler } from '../../src/queue/reconciler.js';
import { SendSpacer } from '../../src/queue/spacing.js';
import { createEmailProcessor } from '../../src/workers/email.processor.js';
import {
  createEmail,
  createUser,
  db,
  FakeMailer,
  noopIndexer,
  resetDatabase,
  resetRedis,
} from '../helpers.js';

/**
 * End-to-end through REAL BullMQ + Redis + PostgreSQL. Only SMTP is faked.
 */
const redis = sharedRedis();
const queues = createQueues(redis);
const workers: Worker[] = [];

function startWorker(mailer: FakeMailer, opts: { windowMs?: number; senderLimit?: number } = {}) {
  const worker = new Worker<EmailJobData>(
    EMAIL_QUEUE,
    createEmailProcessor({
      db,
      logger,
      quota: new HourlyQuota(redis, { prefix: env.QUEUE_PREFIX, windowMs: opts.windowMs ?? 3_600_000 }),
      spacer: new SendSpacer(redis, env.QUEUE_PREFIX),
      mailer,
      indexer: noopIndexer,
      notifier: { onLimitReached: async () => 'no-connection' as const },
      settings: {
        senderHourlyLimit: opts.senderLimit ?? 100,
        globalHourlyLimit: 1000,
        minDelayMs: 0,
        uploadDir: './uploads-test',
        messageIdDomain: 'test.local',
      },
    }),
    {
      connection: createRedis('test-worker'),
      prefix: env.QUEUE_PREFIX,
      concurrency: 3,
      stalledInterval: 5_000,
    },
  );
  workers.push(worker);
  return worker;
}

async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const statusOf = (id: string) => db.email.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await resetDatabase();
  await resetRedis();
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.close()));
});
afterAll(async () => {
  await closeQueues(queues);
  await resetRedis();
  await closeSharedRedis();
  await db.$disconnect();
});

describe('BullMQ delayed scheduling (real Redis)', () => {
  it('does not send before scheduledAt and sends once due', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({
      userId: user.id,
      senderId: sender.id,
      scheduledAt: new Date(Date.now() + 1_500),
    });
    await enqueueEmails({ db, queue: queues.email, logger }, [email]);
    const mailer = new FakeMailer();
    startWorker(mailer);

    await new Promise((r) => setTimeout(r, 700));
    expect((await statusOf(email.id)).status).toBe('SCHEDULED');
    expect(await queues.email.getJobState(emailJobId(email.id))).toBe('delayed');

    const row = await waitFor(
      () => statusOf(email.id),
      (r) => r.status === 'SENT',
    );
    expect(row.sentAt!.getTime()).toBeGreaterThanOrEqual(email.scheduledAt.getTime());
    expect(mailer.sent).toHaveLength(1);
  });

  it('pending work survives a worker restart without changing the scheduled time', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({
      userId: user.id,
      senderId: sender.id,
      scheduledAt: new Date(Date.now() + 2_000),
    });
    await enqueueEmails({ db, queue: queues.email, logger }, [email]);

    const first = startWorker(new FakeMailer());
    await new Promise((r) => setTimeout(r, 300));
    await first.close(); // "crash"/restart before the job is due
    workers.splice(workers.indexOf(first), 1);

    const mailer = new FakeMailer();
    startWorker(mailer);
    const row = await waitFor(
      () => statusOf(email.id),
      (r) => r.status === 'SENT',
    );
    expect(row.scheduledAt.getTime()).toBe(email.scheduledAt.getTime());
    expect(mailer.sent).toHaveLength(1);
  });

  it('retries a transient failure with backoff and then succeeds', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    await enqueueEmails({ db, queue: queues.email, logger }, [email]);
    const mailer = new FakeMailer();
    let calls = 0;
    const original = mailer.send.bind(mailer);
    mailer.send = async (c, m) => {
      calls++;
      if (calls === 1) throw new SmtpError('421 busy', 'transient', 'SMTP_421');
      return original(c, m);
    };
    startWorker(mailer);
    const row = await waitFor(
      () => statusOf(email.id),
      (r) => r.status === 'SENT',
    );
    expect(row.attemptCount).toBe(2);
    expect(mailer.sent).toHaveLength(1);
    const events = await db.emailEvent.findMany({
      where: { emailId: email.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.status)).toContain('RETRYING');
  });

  it('quota-exceeded jobs are moved to the next window with the real moveToDelayed API and then sent', async () => {
    const { user, sender } = await createUser();
    const a = await createEmail({ userId: user.id, senderId: sender.id });
    const b = await createEmail({ userId: user.id, senderId: sender.id });
    await enqueueEmails({ db, queue: queues.email, logger }, [a, b]);
    const mailer = new FakeMailer();
    // 2-second windows keep the test fast; production uses 1h (RATE_LIMIT_WINDOW_MS).
    startWorker(mailer, { windowMs: 2_000, senderLimit: 1 });

    await waitFor(
      () => db.email.count({ where: { status: 'SENT' } }),
      (n) => n === 1,
    );
    const deferred = await db.email.findFirstOrThrow({ where: { status: 'SCHEDULED' } });
    expect(deferred.deferredUntil).not.toBeNull();
    expect(await queues.email.getJobState(emailJobId(deferred.id))).toBe('delayed');

    await waitFor(
      () => db.email.count({ where: { status: 'SENT' } }),
      (n) => n === 2,
      8_000,
    );
    const sentRows = await db.email.findMany({ orderBy: { sentAt: 'asc' } });
    const w = (d: Date) => Math.floor(d.getTime() / 2_000);
    expect(w(sentRows[1]!.sentAt!)).toBeGreaterThan(w(sentRows[0]!.sentAt!)); // different windows
    expect(mailer.sent).toHaveLength(2);
    expect(sentRows.every((r) => r.attemptCount === 1)).toBe(true); // deferral consumed no attempt
  });
});

describe('scheduling regressions (real BullMQ)', () => {
  it('a job made runnable early (no delay) is still not sent before scheduledAt', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({
      userId: user.id,
      senderId: sender.id,
      scheduledAt: new Date(Date.now() + 2_000),
    });
    // Simulate a buggy enqueue / manual retry: the job is immediately available.
    await queues.email.add('send', { emailId: email.id }, { jobId: emailJobId(email.id) });
    const mailer = new FakeMailer();
    startWorker(mailer);

    await waitFor(
      () => queues.email.getJobState(emailJobId(email.id)),
      (s) => s === 'delayed',
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(mailer.sent).toHaveLength(0);
    expect((await statusOf(email.id)).status).toBe('SCHEDULED');

    const row = await waitFor(
      () => statusOf(email.id),
      (r) => r.status === 'SENT',
    );
    expect(row.sentAt!.getTime()).toBeGreaterThanOrEqual(email.scheduledAt.getTime());
    expect(row.attemptCount).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('emails with different scheduled times are each sent at their own time', async () => {
    const { user, sender } = await createUser();
    const now = Date.now();
    const offsets = [2_400, 600, 1_500];
    const emails = [];
    for (const ms of offsets) {
      emails.push(
        await createEmail({ userId: user.id, senderId: sender.id, scheduledAt: new Date(now + ms) }),
      );
    }
    await enqueueEmails({ db, queue: queues.email, logger }, emails);
    const mailer = new FakeMailer();
    startWorker(mailer);

    await waitFor(
      () => db.email.count({ where: { status: 'SENT' } }),
      (n) => n === 3,
    );
    const rows = await db.email.findMany({ where: { userId: user.id } });
    for (const r of rows) expect(r.sentAt!.getTime()).toBeGreaterThanOrEqual(r.scheduledAt.getTime());
    const sendOrder = [...rows].sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime()).map((r) => r.id);
    const scheduleOrder = [...rows]
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .map((r) => r.id);
    expect(sendOrder).toEqual(scheduleOrder);
  });

  it('the reconciler replaces a failed job with a delayed one instead of running it now', async () => {
    const { user, sender } = await createUser();
    const scheduledAt = new Date(Date.now() + 60_000);
    const email = await createEmail({ userId: user.id, senderId: sender.id, scheduledAt });
    // Put a job for this still-pending email into the failed set.
    await queues.email.add('send', { emailId: email.id }, { jobId: emailJobId(email.id) });
    const failing = new Worker<EmailJobData>(
      EMAIL_QUEUE,
      async () => {
        throw new UnrecoverableError('simulated crash');
      },
      { connection: createRedis('failing-worker'), prefix: env.QUEUE_PREFIX },
    );
    workers.push(failing);
    await waitFor(
      () => queues.email.getJobState(emailJobId(email.id)),
      (s) => s === 'failed',
    );
    await failing.close();
    workers.splice(workers.indexOf(failing), 1);

    const result = await new OutboxReconciler({ db, queue: queues.email, logger }).verifyJobs();
    expect(result.repaired).toBe(1);
    expect(await queues.email.getJobState(emailJobId(email.id))).toBe('delayed');
    const job = await queues.email.getJob(emailJobId(email.id));
    expect(Math.abs(job!.timestamp + job!.opts.delay! - scheduledAt.getTime())).toBeLessThan(1_000);
  });
});
