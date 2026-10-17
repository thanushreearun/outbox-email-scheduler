import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import type { RateLimitType } from '@prisma/client';
import type { Db } from '../lib/prisma.js';
import type { Logger } from '../lib/logger.js';
import { windowStart } from '../lib/time.js';
import {
  classifySmtpError,
  resolveCredentials,
  SenderConfigError,
  SmtpError,
  type Mailer,
  type SmtpCredentials,
} from '../integrations/mailer.js';
import { transitionEmail } from '../modules/emails/email.repository.js';
import { CLAIMABLE_STATUSES, isTerminal } from '../modules/emails/status.js';
import type { LimitReachedEvent, NotifyOutcome } from '../modules/slack/rate-limit-notifier.js';
import type { HourlyQuota, LimitType } from '../queue/rate-limiter.js';
import type { SendSpacer } from '../queue/spacing.js';
import type { EmailJobData } from '../queue/queues.js';

export interface EmailProcessorDeps {
  db: Db;
  logger: Logger;
  quota: Pick<HourlyQuota, 'reserve' | 'release' | 'consume'>;
  spacer: Pick<SendSpacer, 'waitForTurn' | 'done'>;
  mailer: Pick<Mailer, 'send'>;
  indexer: { syncSoon(ids: string[]): void };
  notifier: { onLimitReached(e: LimitReachedEvent): Promise<NotifyOutcome> };
  /** Clock override for tests; defaults to Date.now. */
  now?: () => number;
  settings: {
    senderHourlyLimit: number;
    globalHourlyLimit: number;
    minDelayMs: number;
    uploadDir: string;
    messageIdDomain: string;
  };
}

/** Longer than the SMTP connection + greeting + socket timeouts combined (see mailer.ts). */
export const SENDING_STALE_MS = 2 * 60_000;

export type ProcessOutcome =
  | 'sent'
  | 'skipped-missing'
  | 'skipped-terminal'
  | 'skipped-lost-claim'
  | 'failed-permanent'
  | 'failed-uncertain';

/**
 * Processes one email job. Safe to run any number of times for the same email:
 *
 * 1. Terminal rows are acknowledged without side effects (re-delivery, duplicate jobs).
 * 2. A row left in SENDING for longer than SENDING_STALE_MS means a previous worker died
 *    mid-SMTP. The provider may have accepted it, so we do NOT resend automatically
 *    (at-most-once for the ambiguous case); it is marked FAILED with code
 *    DELIVERY_UNCERTAIN for a human to review. A fresh SENDING row is left alone.
 * 3. A job that runs before the email's due time is re-delayed to that time, unsent.
 *    A conditional claim (status + new claim token) then guarantees one active claimant.
 * 4. Hourly quota is reserved atomically; if exhausted, the job is moved back to the delayed
 *    set for the reserved future window (no attempt consumed, nothing dropped).
 * 5. The cross-worker spacing slot is awaited.
 * 6. SENDING is persisted *before* SMTP, SENT immediately after.
 */
export function createEmailProcessor(deps: EmailProcessorDeps) {
  const { db, logger, settings } = deps;
  const now = deps.now ?? Date.now;

  return async function processEmailJob(job: Job<EmailJobData>, token?: string): Promise<ProcessOutcome> {
    const emailId = job.data.emailId;
    const log = logger.child({ jobId: job.id, emailId, attempt: job.attemptsMade + 1 });

    const email = await db.email.findUnique({
      where: { id: emailId },
      include: { senderAccount: true, batch: { include: { attachments: true } } },
    });
    if (!email) {
      log.warn('email row not found; acknowledging job');
      return 'skipped-missing';
    }
    if (isTerminal(email.status)) {
      log.info({ status: email.status }, 'email already terminal; no side effects');
      return 'skipped-terminal';
    }
    if (email.status === 'SENDING') {
      // A fresh SENDING row may belong to a live worker (e.g. a falsely detected stall);
      // only a row older than every SMTP timeout is evidence of a crash.
      if (Date.now() - email.updatedAt.getTime() < SENDING_STALE_MS) {
        throw new Error('Email is in flight on another worker; will re-check after backoff');
      }
      await transitionEmail(db, {
        emailId,
        from: ['SENDING'],
        to: 'FAILED',
        data: {
          lastErrorCode: 'DELIVERY_UNCERTAIN',
          lastError:
            'Worker stopped during the SMTP transaction. The provider may have accepted the message, so it was not re-sent automatically.',
          claimToken: null,
        },
        message: 'Outcome of interrupted SMTP transaction is unknown',
      });
      await deps.quota.consume(emailId);
      deps.indexer.syncSoon([emailId]);
      log.error('interrupted SMTP transaction detected; marked DELIVERY_UNCERTAIN instead of re-sending');
      return 'failed-uncertain';
    }

    // 0. Never send before the persisted due time, whatever made the job runnable
    // (manual retry from the dashboard, recovery, clock skew). Deferring here happens before
    // the claim, so the row stays SCHEDULED and no attempt is consumed.
    const dueAt = Math.max(email.scheduledAt.getTime(), email.deferredUntil?.getTime() ?? 0);
    if (now() < dueAt) {
      log.warn({ dueAt: new Date(dueAt).toISOString() }, 'job ran before its due time; re-delayed');
      await job.moveToDelayed(dueAt, token);
      throw new DelayedError();
    }

    // 1. Claim
    const claimToken = randomUUID();
    const claimed = await transitionEmail(db, {
      emailId,
      from: CLAIMABLE_STATUSES,
      to: 'PROCESSING',
      data: { claimToken, claimedAt: new Date() },
    });
    if (!claimed) {
      log.info('could not claim email (cancelled or claimed concurrently)');
      return 'skipped-lost-claim';
    }

    const failPermanently = async (code: string, message: string): Promise<ProcessOutcome> => {
      await deps.quota.release(emailId, email.senderAccountId, email.batchId);
      await transitionEmail(db, {
        emailId,
        from: ['PROCESSING'],
        to: 'FAILED',
        claimToken,
        data: { lastErrorCode: code, lastError: message, claimToken: null },
        message,
      });
      deps.indexer.syncSoon([emailId]);
      log.warn({ code }, 'email failed before SMTP');
      return 'failed-permanent';
    };

    // 2. Sender validity
    if (!email.senderAccount.isActive)
      return failPermanently('SENDER_INACTIVE', 'Sender account is disabled');
    let credentials: SmtpCredentials;
    try {
      credentials = resolveCredentials(email.senderAccount);
    } catch (err) {
      if (err instanceof SenderConfigError) return failPermanently('SENDER_CONFIG', err.message);
      throw err;
    }

    // 3. Hourly quota
    const reservation = await deps.quota.reserve({
      emailId,
      senderId: email.senderAccountId,
      batchId: email.batchId,
      notBeforeMs: email.scheduledAt.getTime(),
      senderLimit: settings.senderHourlyLimit,
      globalLimit: settings.globalHourlyLimit,
      batchLimit: email.batch.hourlyLimit,
    });
    const spacingMs = Math.max(settings.minDelayMs, email.batch.delayBetweenMs);

    if (reservation.blockedNow.length > 0) {
      await notifyLimits(deps, log, reservation.blockedNow, {
        userId: email.userId,
        senderAccountId: email.senderAccountId,
        senderEmail: email.senderAccount.email,
        batchId: email.batchId,
        batchLimit: email.batch.hourlyLimit,
        currentWindow: reservation.currentWindow,
        windowMs: reservation.windowMs,
      });
    }

    if (reservation.window === null || reservation.window > reservation.currentWindow) {
      // Stagger wake-ups inside the target window by booking position so ordering is
      // preserved and the window does not start with a thundering herd.
      const targetWindow = reservation.window ?? reservation.currentWindow + 24;
      const offset = Math.min(reservation.position * spacingMs, reservation.windowMs - 1_000);
      const runAt = Math.max(
        email.scheduledAt.getTime(),
        windowStart(targetWindow, reservation.windowMs) + (reservation.window === null ? 0 : offset),
      );
      const moved = await transitionEmail(db, {
        emailId,
        from: ['PROCESSING'],
        to: 'SCHEDULED',
        claimToken,
        data: { deferredUntil: new Date(runAt), claimToken: null },
        message: `Hourly limit reached; deferred to ${new Date(runAt).toISOString()}`,
      });
      deps.indexer.syncSoon([emailId]);
      log.info({ runAt: new Date(runAt).toISOString(), moved }, 'deferred by hourly limit');
      await job.moveToDelayed(runAt, token);
      throw new DelayedError();
    }

    // 4. Spacing across all workers
    await deps.spacer.waitForTurn(email.senderAccountId, emailId, spacingMs);

    // 5. Durable "about to send" marker
    const marked = await transitionEmail(db, {
      emailId,
      from: ['PROCESSING'],
      to: 'SENDING',
      claimToken,
      data: { attemptCount: { increment: 1 } },
    });
    if (!marked) {
      log.warn('claim lost before SMTP; another worker owns this email');
      return 'skipped-lost-claim';
    }

    // 6. SMTP
    try {
      const result = await deps.mailer.send(credentials, {
        from: { name: email.senderAccount.displayName, address: email.senderAccount.email },
        to: { name: email.recipientName, address: email.recipientEmail },
        subject: email.subject,
        html: email.batch.bodyHtml,
        text: email.batch.bodyText,
        messageId: `<${email.id}@${settings.messageIdDomain}>`,
        attachments: email.batch.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.mimeType,
          path: path.resolve(settings.uploadDir, a.storageKey),
        })),
      });
      await Promise.all([deps.quota.consume(emailId), deps.spacer.done(emailId)]);
      await transitionEmail(db, {
        emailId,
        from: ['SENDING'],
        to: 'SENT',
        claimToken,
        data: {
          sentAt: new Date(),
          providerMessageId: result.messageId,
          previewUrl: result.previewUrl,
          lastError: null,
          lastErrorCode: null,
          claimToken: null,
        },
        message: result.response,
      });
      deps.indexer.syncSoon([emailId]);
      log.info({ previewUrl: result.previewUrl ?? undefined }, 'email sent');
      return 'sent';
    } catch (raw) {
      const err = raw instanceof SmtpError ? raw : classifySmtpError(raw);
      await Promise.all([deps.quota.consume(emailId), deps.spacer.done(emailId)]);
      const maxAttempts = job.opts.attempts ?? 1;
      const final = err.kind === 'permanent' || job.attemptsMade + 1 >= maxAttempts;
      await transitionEmail(db, {
        emailId,
        from: ['SENDING'],
        to: final ? 'FAILED' : 'RETRYING',
        claimToken,
        data: { lastError: err.message, lastErrorCode: err.code, ...(final ? { claimToken: null } : {}) },
        message: err.message,
      });
      deps.indexer.syncSoon([emailId]);
      log.warn({ code: err.code, kind: err.kind, final }, 'SMTP send failed');
      if (err.kind === 'permanent') throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}

async function notifyLimits(
  deps: EmailProcessorDeps,
  log: Logger,
  blocked: LimitType[],
  ctx: {
    userId: string;
    senderAccountId: string;
    senderEmail: string;
    batchId: string;
    batchLimit: number | null;
    currentWindow: number;
    windowMs: number;
  },
): Promise<void> {
  const limitValue: Record<LimitType, number> = {
    SENDER: deps.settings.senderHourlyLimit,
    GLOBAL: deps.settings.globalHourlyLimit,
    BATCH: ctx.batchLimit ?? 0,
  };
  for (const type of blocked) {
    try {
      await deps.notifier.onLimitReached({
        userId: ctx.userId,
        senderAccountId: ctx.senderAccountId,
        senderEmail: ctx.senderEmail,
        limitType: type as RateLimitType,
        scopeKey: type === 'BATCH' ? ctx.batchId : '',
        windowStart: new Date(windowStart(ctx.currentWindow, ctx.windowMs)),
        limitValue: limitValue[type],
        resumesAt: new Date(windowStart(ctx.currentWindow + 1, ctx.windowMs)),
      });
    } catch (err) {
      // Notifications must never block or fail email processing.
      log.warn({ err: (err as Error).message, type }, 'rate-limit notification error');
    }
  }
}
