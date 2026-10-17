import { randomUUID } from 'node:crypto';
import type { RateLimitType } from '@prisma/client';
import { decryptSecret } from '../../lib/crypto.js';
import type { Db } from '../../lib/prisma.js';
import type { Logger } from '../../lib/logger.js';
import { SlackApiError, type SlackClient } from './slack.client.js';

export interface LimitReachedEvent {
  userId: string;
  senderAccountId: string;
  senderEmail: string;
  limitType: RateLimitType;
  /** Distinguishes several batches on one sender for BATCH limits; '' otherwise. */
  scopeKey: string;
  windowStart: Date;
  limitValue: number;
  resumesAt: Date;
}

export type NotifyOutcome = 'sent' | 'duplicate' | 'no-connection' | 'failed' | 'slack-not-configured';

const NO_CONNECTION = 'NO_SLACK_CONNECTION';
const MAX_NOTIFY_ATTEMPTS = 5;

/**
 * De-duplication: the (sender, limitType, scopeKey, windowStart) unique key means only the
 * first worker that observes an exhausted window creates the event row; every other job,
 * retry or worker hitting the same limit in that window inserts nothing and skips
 * Slack entirely. Failed deliveries are retried by the maintenance worker, not by the jobs.
 */
export class RateLimitNotifier {
  constructor(private readonly deps: { db: Db; logger: Logger; slack: SlackClient | null }) {}

  async onLimitReached(e: LimitReachedEvent): Promise<NotifyOutcome> {
    const eventId = randomUUID();
    // INSERT ... ON CONFLICT DO NOTHING: count 0 means another job already claimed this window.
    const { count } = await this.deps.db.rateLimitEvent.createMany({
      data: [
        {
          id: eventId,
          userId: e.userId,
          senderAccountId: e.senderAccountId,
          limitType: e.limitType,
          scopeKey: e.scopeKey,
          windowStart: e.windowStart,
          limitValue: e.limitValue,
          resumesAt: e.resumesAt,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return 'duplicate';
    this.deps.logger.info(
      { senderAccountId: e.senderAccountId, limitType: e.limitType, windowStart: e.windowStart },
      'hourly limit reached',
    );
    return this.deliver(eventId);
  }

  async deliver(eventId: string): Promise<NotifyOutcome> {
    const { db, logger, slack } = this.deps;
    const event = await db.rateLimitEvent.findUnique({
      where: { id: eventId },
      include: { senderAccount: { select: { email: true, displayName: true } } },
    });
    if (!event || event.notifiedAt) return 'duplicate';
    if (!slack) {
      await db.rateLimitEvent.update({
        where: { id: eventId },
        data: { notifyError: 'SLACK_NOT_CONFIGURED' },
      });
      return 'slack-not-configured';
    }
    const conn = await db.slackConnection.findUnique({ where: { userId: event.userId } });
    if (!conn || conn.status !== 'ACTIVE') {
      await db.rateLimitEvent.update({ where: { id: eventId }, data: { notifyError: NO_CONNECTION } });
      return 'no-connection';
    }

    try {
      await slack.postWebhook(decryptSecret(conn.webhookUrlEncrypted), buildMessage(event));
      await db.$transaction([
        db.rateLimitEvent.update({
          where: { id: eventId },
          data: { notifiedAt: new Date(), notifyError: null },
        }),
        db.slackConnection.update({
          where: { id: conn.id },
          data: { lastNotifiedAt: new Date(), lastError: null },
        }),
      ]);
      return 'sent';
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      const kind = err instanceof SlackApiError ? err.kind : 'transient';
      await db.rateLimitEvent.update({
        where: { id: eventId },
        data: {
          notifyAttempts: { increment: 1 },
          notifyError: kind === 'transient' ? message : `PERMANENT: ${message}`,
        },
      });
      if (kind === 'revoked') {
        await db.slackConnection.update({
          where: { id: conn.id },
          data: { status: 'REVOKED', lastError: message },
        });
      } else if (kind === 'invalid') {
        await db.slackConnection.update({
          where: { id: conn.id },
          data: { status: 'ERROR', lastError: message },
        });
      }
      logger.warn({ eventId, kind, err: message }, 'slack notification failed');
      return 'failed';
    }
  }

  /** Retries transient Slack failures for recent events. Called by the maintenance worker. */
  async retryPending(): Promise<number> {
    const pending = await this.deps.db.rateLimitEvent.findMany({
      where: {
        notifiedAt: null,
        notifyAttempts: { gt: 0, lt: MAX_NOTIFY_ATTEMPTS },
        NOT: { notifyError: { startsWith: 'PERMANENT' } },
        createdAt: { gt: new Date(Date.now() - 2 * 3_600_000) },
      },
      select: { id: true },
      take: 50,
    });
    let sent = 0;
    for (const p of pending) if ((await this.deliver(p.id)) === 'sent') sent++;
    return sent;
  }
}

const LIMIT_LABEL: Record<RateLimitType, string> = {
  SENDER: 'per-sender hourly limit',
  GLOBAL: 'global hourly limit',
  BATCH: 'campaign hourly limit',
};

/** Contains sender identity and timing only — never recipients or message content. */
export function buildMessage(event: {
  limitType: RateLimitType;
  limitValue: number;
  windowStart: Date;
  resumesAt: Date;
  senderAccount: { email: string; displayName: string | null };
}) {
  const windowEnd = new Date(event.windowStart.getTime() + 3_600_000);
  const fmt = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const sender = event.senderAccount.displayName
    ? `${event.senderAccount.displayName} <${event.senderAccount.email}>`
    : event.senderAccount.email;
  const text = `Hourly sending limit reached for ${sender}: ${event.limitValue} emails (${LIMIT_LABEL[event.limitType]}). Remaining emails are queued and will resume at ${fmt(event.resumesAt)}.`;
  return {
    text,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':hourglass_flowing_sand: Hourly sending limit reached' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Sender*\n${sender}` },
          { type: 'mrkdwn', text: `*Limit*\n${event.limitValue} / hour (${LIMIT_LABEL[event.limitType]})` },
          { type: 'mrkdwn', text: `*Window*\n${fmt(event.windowStart)} – ${fmt(windowEnd).slice(11)}` },
          { type: 'mrkdwn', text: `*Resumes*\n${fmt(event.resumesAt)}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'No emails were dropped. Deferred emails stay queued and send automatically.',
          },
        ],
      },
    ],
  };
}
