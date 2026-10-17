import { DelayedError, UnrecoverableError } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { SmtpError } from '../../src/integrations/mailer.js';
import { closeSharedRedis, sharedRedis } from '../../src/lib/redis.js';
import { logger } from '../../src/lib/logger.js';
import { HourlyQuota } from '../../src/queue/rate-limiter.js';
import { SendSpacer } from '../../src/queue/spacing.js';
import { RateLimitNotifier } from '../../src/modules/slack/rate-limit-notifier.js';
import type { SlackClient } from '../../src/modules/slack/slack.client.js';
import { encryptSecret } from '../../src/lib/crypto.js';
import { transitionEmail } from '../../src/modules/emails/email.repository.js';
import { createEmailProcessor, type EmailProcessorDeps } from '../../src/workers/email.processor.js';
import {
  createEmail,
  createUser,
  db,
  FakeMailer,
  fakeJob,
  noopIndexer,
  resetDatabase,
  resetRedis,
} from '../helpers.js';

const redis = sharedRedis();

function buildProcessor(overrides: Partial<EmailProcessorDeps> & { senderLimit?: number } = {}) {
  const mailer = new FakeMailer();
  const postWebhook = vi.fn(async (_url: string, _payload: unknown) => undefined);
  const slack = { postWebhook } as unknown as SlackClient;
  const deps: EmailProcessorDeps = {
    db,
    logger,
    quota: new HourlyQuota(redis, { prefix: env.QUEUE_PREFIX, windowMs: 3_600_000 }),
    spacer: new SendSpacer(redis, env.QUEUE_PREFIX),
    mailer,
    indexer: noopIndexer,
    notifier: new RateLimitNotifier({ db, logger, slack }),
    settings: {
      senderHourlyLimit: overrides.senderLimit ?? 100,
      globalHourlyLimit: 1000,
      minDelayMs: 0,
      uploadDir: './uploads-test',
      messageIdDomain: 'test.local',
    },
    ...overrides,
  };
  return { process: createEmailProcessor(deps), mailer, postWebhook };
}

beforeEach(async () => {
  await resetDatabase();
  await resetRedis();
});
afterAll(async () => {
  await resetRedis();
  await closeSharedRedis();
  await db.$disconnect();
});

describe('email processor', () => {
  it('sends an eligible email once and records SENT with an audit trail', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();

    await expect(process(fakeJob(email.id), 'token')).resolves.toBe('sent');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.message.messageId).toBe(`<${email.id}@test.local>`);
    expect(mailer.sent[0]!.credentials.user).toBe('test-sender@ethereal.test');

    const row = await db.email.findUniqueOrThrow({ where: { id: email.id }, include: { events: true } });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(row.attemptCount).toBe(1);
    expect(row.events.map((e) => e.status)).toEqual(['PROCESSING', 'SENDING', 'SENT']);
  });

  it('re-processing an already-sent email does not send again', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();
    await process(fakeJob(email.id), 't');
    await expect(process(fakeJob(email.id), 't')).resolves.toBe('skipped-terminal');
    expect(mailer.sent).toHaveLength(1);
  });

  it('a crash after SMTP started (row left in SENDING) is not blindly re-sent', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id, status: 'SENDING' });
    const { process, mailer } = buildProcessor();
    // While fresh, SENDING may be a live worker: back off without touching the row.
    await expect(process(fakeJob(email.id), 't')).rejects.toThrow(/in flight/);
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('SENDING');
    // Once older than every SMTP timeout it is treated as a crash mid-transaction.
    await db.$executeRaw`UPDATE "Email" SET "updatedAt" = now() - interval '10 minutes' WHERE id = ${email.id}`;
    await expect(process(fakeJob(email.id), 't')).resolves.toBe('failed-uncertain');
    expect(mailer.sent).toHaveLength(0);
    const row = await db.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastErrorCode).toBe('DELIVERY_UNCERTAIN');
  });

  it('a crash before SMTP (row left in PROCESSING) is safely re-claimed and sent', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id, status: 'PROCESSING' });
    const { process, mailer } = buildProcessor();
    await expect(process(fakeJob(email.id), 't')).resolves.toBe('sent');
    expect(mailer.sent).toHaveLength(1);
  });

  it('transient SMTP failure → RETRYING and rethrows so BullMQ retries with backoff', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();
    mailer.failWith = new SmtpError('421 try later', 'transient', 'SMTP_421');
    await expect(process(fakeJob(email.id, { attemptsMade: 0, attempts: 3 }), 't')).rejects.toThrow(
      '421 try later',
    );
    let row = await db.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.status).toBe('RETRYING');
    expect(row.lastErrorCode).toBe('SMTP_421');

    // Retry succeeds.
    mailer.failWith = null;
    await expect(process(fakeJob(email.id, { attemptsMade: 1, attempts: 3 }), 't')).resolves.toBe('sent');
    row = await db.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.status).toBe('SENT');
    expect(row.attemptCount).toBe(2);
  });

  it('transient failure on the final attempt → FAILED', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();
    mailer.failWith = new SmtpError('timeout', 'transient', 'ETIMEDOUT');
    await expect(process(fakeJob(email.id, { attemptsMade: 2, attempts: 3 }), 't')).rejects.toThrow();
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('FAILED');
  });

  it('permanent SMTP failure → FAILED immediately via UnrecoverableError (no retries)', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();
    mailer.failWith = new SmtpError('550 no such user', 'permanent', 'SMTP_550');
    await expect(process(fakeJob(email.id), 't')).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('FAILED');
  });

  describe('due-time guard (regression: emails must never send early)', () => {
    it('a job processed before scheduledAt is re-delayed to scheduledAt and not sent', async () => {
      const { user, sender } = await createUser();
      const scheduledAt = new Date(Date.now() + 5 * 60_000);
      const email = await createEmail({ userId: user.id, senderId: sender.id, scheduledAt });
      const { process, mailer } = buildProcessor();
      const job = fakeJob(email.id);

      await expect(process(job, 'token')).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(scheduledAt.getTime(), 'token');
      expect(mailer.sent).toHaveLength(0);
      const row = await db.email.findUniqueOrThrow({ where: { id: email.id }, include: { events: true } });
      expect(row.status).toBe('SCHEDULED');
      expect(row.attemptCount).toBe(0);
      expect(row.events).toHaveLength(0); // never claimed
    });

    it('sends once the clock reaches scheduledAt (controlled clock)', async () => {
      const { user, sender } = await createUser();
      const scheduledAt = new Date(Date.now() + 5 * 60_000);
      const email = await createEmail({ userId: user.id, senderId: sender.id, scheduledAt });

      const early = buildProcessor({ now: () => scheduledAt.getTime() - 1 });
      await expect(early.process(fakeJob(email.id), 't')).rejects.toBeInstanceOf(DelayedError);
      expect(early.mailer.sent).toHaveLength(0);

      const due = buildProcessor({ now: () => scheduledAt.getTime() });
      await expect(due.process(fakeJob(email.id), 't')).resolves.toBe('sent');
      expect(due.mailer.sent).toHaveLength(1);
    });

    it('respects deferredUntil set by a rate-limit deferral', async () => {
      const { user, sender } = await createUser();
      const email = await createEmail({ userId: user.id, senderId: sender.id });
      const deferredUntil = new Date(Date.now() + 10 * 60_000);
      await db.email.update({ where: { id: email.id }, data: { deferredUntil } });
      const { process, mailer } = buildProcessor();
      const job = fakeJob(email.id);
      await expect(process(job, 't')).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(deferredUntil.getTime(), 't');
      expect(mailer.sent).toHaveLength(0);
    });

    it('a retry attempt of an overdue email still sends immediately', async () => {
      const { user, sender } = await createUser();
      const email = await createEmail({
        userId: user.id,
        senderId: sender.id,
        status: 'RETRYING',
        scheduledAt: new Date(Date.now() - 60_000),
      });
      const { process, mailer } = buildProcessor();
      await expect(process(fakeJob(email.id, { attemptsMade: 1 }), 't')).resolves.toBe('sent');
      expect(mailer.sent).toHaveLength(1);
    });
  });

  it('rejects transitions the lifecycle does not allow', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id, status: 'SENT' });
    await expect(transitionEmail(db, { emailId: email.id, from: ['SENT'], to: 'SCHEDULED' })).rejects.toThrow(
      /Illegal email status transition/,
    );
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('SENT');
  });

  it('cancelled emails are acknowledged without sending', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    await db.email.update({ where: { id: email.id }, data: { status: 'CANCELLED' } });
    const { process, mailer } = buildProcessor();
    await expect(process(fakeJob(email.id), 't')).resolves.toBe('skipped-terminal');
    expect(mailer.sent).toHaveLength(0);
  });

  it('quota-exceeding jobs are rescheduled to the next window (not dropped) and Slack is notified once', async () => {
    const { user, sender } = await createUser();
    await db.slackConnection.create({
      data: {
        userId: user.id,
        teamId: 'T1',
        scopes: 'incoming-webhook',
        webhookUrlEncrypted: encryptSecret('https://hooks.slack.com/services/T/B/x'),
      },
    });
    const emails = [];
    for (let i = 0; i < 5; i++) emails.push(await createEmail({ userId: user.id, senderId: sender.id }));
    const { process, mailer, postWebhook } = buildProcessor({ senderLimit: 2 });

    const jobs = emails.map((e) => fakeJob(e.id));
    const outcomes = await Promise.allSettled(jobs.map((j) => process(j, 't')));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
    const deferred = outcomes.filter((o) => o.status === 'rejected');
    expect(deferred).toHaveLength(3);
    for (const d of deferred) expect((d as PromiseRejectedResult).reason).toBeInstanceOf(DelayedError);
    expect(mailer.sent).toHaveLength(2);

    const nextWindow = (Math.floor(Date.now() / 3_600_000) + 1) * 3_600_000;
    const rows = await db.email.findMany({ where: { userId: user.id, status: 'SCHEDULED' } });
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.deferredUntil!.getTime()).toBeGreaterThanOrEqual(nextWindow);
      expect(r.scheduledAt.getTime()).toBeLessThan(nextWindow); // original schedule preserved
    }
    const delayedTo = jobs.flatMap((j) => j.moveToDelayed.mock.calls.map((c) => c[0] as number));
    expect(delayedTo).toHaveLength(3);
    expect(Math.min(...delayedTo)).toBeGreaterThanOrEqual(nextWindow);

    // Exactly one notification for (sender, window) despite three blocked jobs.
    expect(postWebhook).toHaveBeenCalledTimes(1);
    const payload = postWebhook.mock.calls[0]![1] as { text: string };
    expect(payload.text).toContain('test-sender@ethereal.test');
    expect(payload.text).not.toContain('@example.com'); // no recipient data
    expect(await db.rateLimitEvent.count()).toBe(1);
  });

  it('works without any Slack connection (scheduler keeps going)', async () => {
    const { user, sender } = await createUser();
    const a = await createEmail({ userId: user.id, senderId: sender.id });
    const b = await createEmail({ userId: user.id, senderId: sender.id });
    const { process } = buildProcessor({ senderLimit: 1 });
    await expect(process(fakeJob(a.id), 't')).resolves.toBe('sent');
    await expect(process(fakeJob(b.id), 't')).rejects.toBeInstanceOf(DelayedError);
    const ev = await db.rateLimitEvent.findFirstOrThrow();
    expect(ev.notifyError).toBe('NO_SLACK_CONNECTION');
  });

  it('a disabled sender fails permanently and releases its quota', async () => {
    const { user, sender } = await createUser();
    await db.senderAccount.update({ where: { id: sender.id }, data: { isActive: false } });
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();
    await expect(process(fakeJob(email.id), 't')).resolves.toBe('failed-permanent');
    expect(mailer.sent).toHaveLength(0);
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).lastErrorCode).toBe(
      'SENDER_INACTIVE',
    );
  });

  it('two workers racing on the same email send it exactly once', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const { process, mailer } = buildProcessor();
    const results = await Promise.allSettled([
      process(fakeJob(email.id), 'a'),
      process(fakeJob(email.id), 'b'),
    ]);
    expect(mailer.sent).toHaveLength(1);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === 'sent')).toHaveLength(1);
    const row = await db.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.status).toBe('SENT');
    expect(row.lastErrorCode).toBeNull();
  });
});
