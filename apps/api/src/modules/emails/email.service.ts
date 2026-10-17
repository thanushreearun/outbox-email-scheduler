import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { Prisma, type EmailStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { Db } from '../../lib/prisma.js';
import type { Logger } from '../../lib/logger.js';
import { pageMeta } from '../../lib/pagination.js';
import { enqueueEmails } from '../../queue/enqueue.js';
import { emailJobId, type EmailJobData } from '../../queue/queues.js';
import type { HourlyQuota } from '../../queue/rate-limiter.js';
import type { SenderService } from '../senders/sender.service.js';
import { transitionEmail } from './email.repository.js';
import type { ScheduleBatchInput } from './email.schemas.js';
import { prepareRecipients, type PreparedRecipients } from './recipients.js';
import { htmlToText, sanitizeEmailHtml, snippetOf } from './sanitize.js';
import { CANCELLABLE_STATUSES, PENDING_STATUSES } from './status.js';

export type EmailView = 'scheduled' | 'sent' | 'failed';

const VIEW_STATUSES: Record<EmailView, readonly EmailStatus[]> = {
  scheduled: PENDING_STATUSES,
  sent: ['SENT', 'FAILED'],
  failed: ['FAILED'],
};

const listInclude = {
  senderAccount: { select: { id: true, email: true, displayName: true } },
  batch: { select: { snippet: true, _count: { select: { attachments: true } } } },
} satisfies Prisma.EmailInclude;

type ListRow = Prisma.EmailGetPayload<{ include: typeof listInclude }>;

export function toListItem(e: ListRow) {
  return {
    id: e.id,
    batchId: e.batchId,
    recipientEmail: e.recipientEmail,
    recipientName: e.recipientName,
    subject: e.subject,
    snippet: e.batch.snippet,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    deferredUntil: e.deferredUntil?.toISOString() ?? null,
    sentAt: e.sentAt?.toISOString() ?? null,
    attemptCount: e.attemptCount,
    lastError: e.lastError,
    lastErrorCode: e.lastErrorCode,
    attachmentCount: e.batch._count.attachments,
    sender: e.senderAccount,
    createdAt: e.createdAt.toISOString(),
  };
}

export interface ScheduleResult {
  replayed: boolean;
  batchId: string;
  totalSubmitted: number;
  accepted: number;
  rejected: PreparedRecipients['rejected'];
  duplicatesRemoved: number;
  firstScheduledAt: string | null;
  lastScheduledAt: string | null;
  effectiveDelayMs: number;
  hourlyLimit: number | null;
  enqueue: { enqueued: number; pendingReconciliation: number };
}

export class EmailService {
  constructor(
    private readonly deps: {
      db: Db;
      queue: Queue<EmailJobData>;
      logger: Logger;
      indexer: { syncSoon(ids: string[]): void };
      quota: Pick<HourlyQuota, 'release'>;
      senders: Pick<SenderService, 'getOwned'>;
    },
  ) {}

  /**
   * Idempotent scheduling.
   * - Same Idempotency-Key + same payload → the original batch is returned (no new rows/jobs).
   * - Same key + different payload → 409, so a key can never silently alias two requests.
   * - Concurrent duplicates are resolved by the (userId, idempotencyKey) unique constraint.
   */
  async schedule(userId: string, idempotencyKey: string, input: ScheduleBatchInput): Promise<ScheduleResult> {
    const prepared = prepareRecipients(input.recipients);
    if (prepared.accepted.length === 0) {
      throw badRequest('No valid recipients', { rejected: prepared.rejected.slice(0, 100) });
    }
    const bodyHtml = sanitizeEmailHtml(input.bodyHtml);
    const bodyText = htmlToText(bodyHtml);
    if (!bodyText && !/<(img|hr)/i.test(bodyHtml)) throw badRequest('Body is empty after sanitisation');

    const delay = input.delayBetweenMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS;
    const hourlyLimit = input.hourlyLimit ?? null;
    const attachmentIds = [...new Set(input.attachmentIds)].sort();
    const startAt = new Date(Math.max(input.startAt.getTime(), Date.now()));
    const requestHash = sha256(
      JSON.stringify({
        senderAccountId: input.senderAccountId,
        recipients: prepared.accepted,
        subject: input.subject,
        bodyHtml,
        startAt: input.startAt.toISOString(),
        delay,
        hourlyLimit,
        attachmentIds,
      }),
    );

    const existing = await this.deps.db.emailBatch.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    if (existing) return this.replay(existing, requestHash, prepared, input.recipients.length);

    const sender = await this.deps.senders.getOwned(userId, input.senderAccountId);
    if (!sender.isActive) throw badRequest('Sender is disabled');

    if (attachmentIds.length > 0) {
      const owned = await this.deps.db.attachment.findMany({
        where: { id: { in: attachmentIds }, userId, batchId: null },
        select: { id: true, sizeBytes: true },
      });
      if (owned.length !== attachmentIds.length)
        throw badRequest('One or more attachments are invalid or already used');
      const total = owned.reduce((sum, a) => sum + a.sizeBytes, 0);
      if (total > 2 * env.MAX_ATTACHMENT_BYTES) throw badRequest('Attachments exceed the total size limit');
    }

    const batchId = randomUUID();
    // Planned send time staggers the batch by the requested delay. The worker independently
    // enforces spacing and hourly limits, so these are lower bounds, not promises.
    const emails = prepared.accepted.map((r, i) => {
      const id = randomUUID();
      return {
        id,
        userId,
        batchId,
        senderAccountId: sender.id,
        recipientEmail: r.email,
        recipientName: r.name,
        subject: input.subject,
        scheduledAt: new Date(startAt.getTime() + i * delay),
        jobId: emailJobId(id),
        idempotencyKey: sha256(`${userId}:${idempotencyKey}:${r.email}`),
      };
    });

    try {
      await this.deps.db.$transaction(
        async (tx) => {
          await tx.emailBatch.create({
            data: {
              id: batchId,
              userId,
              senderAccountId: sender.id,
              idempotencyKey,
              requestHash,
              subject: input.subject,
              bodyHtml,
              bodyText,
              snippet: snippetOf(bodyText),
              startAt,
              delayBetweenMs: delay,
              hourlyLimit,
              totalRecipients: emails.length,
              rejectedCount: prepared.rejected.length,
              duplicateCount: prepared.duplicatesRemoved,
            },
          });
          await tx.email.createMany({ data: emails });
          await tx.emailEvent.createMany({
            data: emails.map((e) => ({ emailId: e.id, status: 'SCHEDULED' as const, message: 'Scheduled' })),
          });
          if (attachmentIds.length > 0) {
            const res = await tx.attachment.updateMany({
              where: { id: { in: attachmentIds }, userId, batchId: null },
              data: { batchId },
            });
            if (res.count !== attachmentIds.length) throw badRequest('Attachments changed concurrently');
          }
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // A concurrent request with the same key won the race.
        const winner = await this.deps.db.emailBatch.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (winner) return this.replay(winner, requestHash, prepared, input.recipients.length);
      }
      throw err;
    }

    // Outbox step 2 — outside the DB transaction by necessity (Redis is not transactional with Postgres).
    const enqueue = await enqueueEmails(
      this.deps,
      emails.map((e) => ({ ...e, deferredUntil: null })),
    );
    this.deps.indexer.syncSoon(emails.map((e) => e.id));
    this.deps.logger.info(
      { batchId, userId, accepted: emails.length, rejected: prepared.rejected.length, ...enqueue },
      'batch scheduled',
    );

    return {
      replayed: false,
      batchId,
      totalSubmitted: input.recipients.length,
      accepted: emails.length,
      rejected: prepared.rejected,
      duplicatesRemoved: prepared.duplicatesRemoved,
      firstScheduledAt: emails[0]!.scheduledAt.toISOString(),
      lastScheduledAt: emails[emails.length - 1]!.scheduledAt.toISOString(),
      effectiveDelayMs: delay,
      hourlyLimit,
      enqueue: { enqueued: enqueue.enqueued, pendingReconciliation: enqueue.failed },
    };
  }

  private async replay(
    batch: { id: string; requestHash: string; delayBetweenMs: number; hourlyLimit: number | null },
    requestHash: string,
    prepared: PreparedRecipients,
    totalSubmitted: number,
  ): Promise<ScheduleResult> {
    if (batch.requestHash !== requestHash) {
      throw conflict('Idempotency-Key was already used with a different request payload');
    }
    // Finish any enqueue that the original request could not complete.
    const pending = await this.deps.db.email.findMany({
      where: { batchId: batch.id, enqueuedAt: null, status: { in: [...PENDING_STATUSES] } },
      select: { id: true, scheduledAt: true, deferredUntil: true },
    });
    const enqueue = pending.length ? await enqueueEmails(this.deps, pending) : { enqueued: 0, failed: 0 };
    const bounds = await this.deps.db.email.aggregate({
      where: { batchId: batch.id },
      _min: { scheduledAt: true },
      _max: { scheduledAt: true },
      _count: true,
    });
    return {
      replayed: true,
      batchId: batch.id,
      totalSubmitted,
      accepted: bounds._count,
      rejected: prepared.rejected,
      duplicatesRemoved: prepared.duplicatesRemoved,
      firstScheduledAt: bounds._min.scheduledAt?.toISOString() ?? null,
      lastScheduledAt: bounds._max.scheduledAt?.toISOString() ?? null,
      effectiveDelayMs: batch.delayBetweenMs,
      hourlyLimit: batch.hourlyLimit,
      enqueue: { enqueued: enqueue.enqueued, pendingReconciliation: enqueue.failed },
    };
  }

  async list(userId: string, view: EmailView, q: { page: number; pageSize: number; status?: EmailStatus[] }) {
    const allowed =
      view === 'scheduled' ? [...VIEW_STATUSES.scheduled, 'CANCELLED' as const] : VIEW_STATUSES[view];
    const statuses = q.status?.length
      ? q.status.filter((s) => allowed.includes(s))
      : [...VIEW_STATUSES[view]];
    const where: Prisma.EmailWhereInput = { userId, status: { in: statuses } };
    const orderBy: Prisma.EmailOrderByWithRelationInput[] =
      view === 'scheduled'
        ? [{ scheduledAt: 'asc' }, { id: 'asc' }]
        : [{ sentAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }, { id: 'asc' }];
    const [rows, total] = await Promise.all([
      this.deps.db.email.findMany({
        where,
        include: listInclude,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.deps.db.email.count({ where }),
    ]);
    return { data: rows.map(toListItem), meta: pageMeta(q.page, q.pageSize, total) };
  }

  /** Loads rows by ID for search results, re-applying the ownership filter and preserving rank order. */
  async hydrate(userId: string, ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await this.deps.db.email.findMany({
      where: { id: { in: ids }, userId },
      include: listInclude,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toListItem(row)] : [];
    });
  }

  async counts(userId: string) {
    const grouped = await this.deps.db.email.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    });
    const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all])) as Partial<
      Record<EmailStatus, number>
    >;
    const sum = (list: readonly EmailStatus[]) => list.reduce((acc, s) => acc + (by[s] ?? 0), 0);
    return {
      scheduled: sum(VIEW_STATUSES.scheduled),
      sent: sum(VIEW_STATUSES.sent),
      failed: by.FAILED ?? 0,
      cancelled: by.CANCELLED ?? 0,
      byStatus: by,
    };
  }

  async get(userId: string, id: string) {
    const email = await this.deps.db.email.findFirst({
      where: { id, userId },
      include: {
        senderAccount: { select: { id: true, email: true, displayName: true } },
        batch: {
          select: {
            bodyHtml: true,
            snippet: true,
            delayBetweenMs: true,
            hourlyLimit: true,
            attachments: { select: { id: true, filename: true, mimeType: true, sizeBytes: true } },
            _count: { select: { attachments: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { status: true, message: true, createdAt: true },
        },
      },
    });
    if (!email) throw notFound('Email not found');
    return {
      ...toListItem(email),
      bodyHtml: email.batch.bodyHtml,
      previewUrl: email.previewUrl,
      providerMessageId: email.providerMessageId,
      delayBetweenMs: email.batch.delayBetweenMs,
      hourlyLimit: email.batch.hourlyLimit,
      attachments: email.batch.attachments,
      events: email.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    };
  }

  async cancel(userId: string, id: string) {
    const email = await this.deps.db.email.findFirst({ where: { id, userId } });
    if (!email) throw notFound('Email not found');
    const ok = await transitionEmail(this.deps.db, {
      emailId: id,
      from: CANCELLABLE_STATUSES,
      to: 'CANCELLED',
      data: { claimToken: null },
      message: 'Cancelled by user',
    });
    if (!ok) {
      const current = await this.deps.db.email.findUnique({ where: { id }, select: { status: true } });
      throw conflict(`Email cannot be cancelled in status ${current?.status ?? 'unknown'}`);
    }
    // Removing the job is an optimisation; if it is locked or already gone, the worker
    // will see CANCELLED and acknowledge it without sending.
    await this.deps.queue.remove(email.jobId).catch(() => 0);
    await this.deps.quota.release(id, email.senderAccountId, email.batchId).catch(() => false);
    this.deps.indexer.syncSoon([id]);
    return { id, status: 'CANCELLED' as const };
  }
}
