import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { sharedRedis } from '../src/lib/redis.js';
import { env } from '../src/config/env.js';
import type { Mailer, OutgoingMessage, SmtpCredentials } from '../src/integrations/mailer.js';
import type { EmailJobData } from '../src/queue/queues.js';

export const db = prisma;

export async function resetDatabase() {
  await db.$executeRawUnsafe(
    'TRUNCATE "EmailEvent","Email","Attachment","EmailBatch","RateLimitEvent","SlackConnection","SenderAccount","Session","OAuthState","User" CASCADE',
  );
}

export async function resetRedis() {
  const redis = sharedRedis();
  const keys = await redis.keys(`${env.QUEUE_PREFIX}:*`);
  if (keys.length) await redis.del(...keys);
}

export async function createUser(email = `user-${randomUUID().slice(0, 8)}@example.com`) {
  const user = await db.user.create({
    data: { googleSub: randomUUID(), email, name: email.split('@')[0]!, avatarUrl: null },
  });
  const sender = await db.senderAccount.create({
    data: {
      userId: user.id,
      email: 'test-sender@ethereal.test',
      provider: 'ETHEREAL_ENV',
      credentialRef: 'env',
      verifiedAt: new Date(),
    },
  });
  return { user, sender };
}

/** Inserts a ready-to-process email row directly (bypassing the API). */
export async function createEmail(opts: {
  userId: string;
  senderId: string;
  status?: 'SCHEDULED' | 'SENT' | 'SENDING' | 'RETRYING' | 'PROCESSING';
  scheduledAt?: Date;
  hourlyLimit?: number | null;
  delayBetweenMs?: number;
  batchId?: string;
  recipient?: string;
}) {
  const batchId = opts.batchId ?? randomUUID();
  await db.emailBatch.upsert({
    where: { id: batchId },
    update: {},
    create: {
      id: batchId,
      userId: opts.userId,
      senderAccountId: opts.senderId,
      idempotencyKey: `key-${batchId}`,
      requestHash: 'x',
      subject: 'Hello',
      bodyHtml: '<p>Hello</p>',
      bodyText: 'Hello',
      snippet: 'Hello',
      startAt: new Date(),
      delayBetweenMs: opts.delayBetweenMs ?? 0,
      hourlyLimit: opts.hourlyLimit ?? null,
      totalRecipients: 1,
    },
  });
  const id = randomUUID();
  return db.email.create({
    data: {
      id,
      userId: opts.userId,
      batchId,
      senderAccountId: opts.senderId,
      recipientEmail: opts.recipient ?? `r-${id.slice(0, 8)}@example.com`,
      subject: 'Hello',
      status: opts.status ?? 'SCHEDULED',
      scheduledAt: opts.scheduledAt ?? new Date(),
      jobId: `email_${id}`,
      idempotencyKey: `idem-${id}`,
      enqueuedAt: new Date(),
    },
  });
}

export class FakeMailer implements Mailer {
  sent: Array<{ credentials: SmtpCredentials; message: OutgoingMessage }> = [];
  failWith: Error | null = null;
  async send(credentials: SmtpCredentials, message: OutgoingMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ credentials, message });
    return {
      messageId: message.messageId,
      response: '250 OK',
      previewUrl: 'https://ethereal.email/message/test',
    };
  }
  async verify() {}
  close() {}
}

export function fakeJob(
  emailId: string,
  overrides: Partial<{ attemptsMade: number; attempts: number }> = {},
) {
  return {
    id: `email_${emailId}`,
    data: { emailId },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
    moveToDelayed: vi.fn(async () => undefined),
  } as unknown as Job<EmailJobData> & { moveToDelayed: ReturnType<typeof vi.fn> };
}

export const noopIndexer = { syncSoon: () => undefined };
