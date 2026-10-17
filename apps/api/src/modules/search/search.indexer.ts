import type { Client } from '@elastic/elasticsearch';
import { env } from '../../config/env.js';
import type { Db } from '../../lib/prisma.js';
import type { Logger } from '../../lib/logger.js';

/**
 * Elasticsearch is a derived read model. Every email row carries `version` (bumped on
 * each change) and `indexedVersion` (last version ES acknowledged). Documents are written
 * with `version_type: external`, so an out-of-order or duplicate write can never replace
 * a newer document. Rows with `indexedVersion < version` are picked up by the reconciler,
 * which makes indexing eventually consistent even across ES outages.
 */

const emailSelect = {
  id: true,
  userId: true,
  batchId: true,
  senderAccountId: true,
  recipientEmail: true,
  recipientName: true,
  subject: true,
  status: true,
  scheduledAt: true,
  sentAt: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  senderAccount: { select: { email: true } },
} as const;

type IndexableEmail = {
  id: string;
  userId: string;
  batchId: string;
  senderAccountId: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  senderAccount: { email: string };
};

export function toSearchDocument(e: IndexableEmail) {
  return {
    userId: e.userId,
    batchId: e.batchId,
    senderAccountId: e.senderAccountId,
    senderEmail: e.senderAccount.email,
    recipientEmail: e.recipientEmail,
    recipientName: e.recipientName ?? undefined,
    subject: e.subject,
    status: e.status,
    scheduledAt: e.scheduledAt.toISOString(),
    sentAt: e.sentAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export class SearchIndexer {
  constructor(private readonly deps: { db: Db; es: Client; logger: Logger }) {}

  /** Best-effort immediate sync; failures are left to the reconciler and never thrown. */
  async syncEmails(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const emails = await this.deps.db.email.findMany({ where: { id: { in: ids } }, select: emailSelect });
      await this.bulkIndex(emails);
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message, count: ids.length }, 'search sync deferred');
    }
  }

  /** Fire-and-forget variant for request/worker hot paths. */
  syncSoon(ids: string[]): void {
    void this.syncEmails(ids);
  }

  /** Index everything that is behind. Returns the number of documents acknowledged. */
  async reconcile(limit = 500): Promise<number> {
    const stale = await this.deps.db.email.findMany({
      where: { indexedVersion: { lt: this.deps.db.email.fields.version } },
      select: emailSelect,
      take: limit,
      orderBy: { updatedAt: 'asc' },
    });
    if (stale.length === 0) return 0;
    return this.bulkIndex(stale);
  }

  private async bulkIndex(emails: IndexableEmail[]): Promise<number> {
    if (emails.length === 0) return 0;
    const operations = emails.flatMap((e) => [
      {
        index: {
          _index: env.ELASTICSEARCH_INDEX,
          _id: e.id,
          version: e.version,
          version_type: 'external' as const,
        },
      },
      toSearchDocument(e),
    ]);
    const res = await this.deps.es.bulk({ operations, refresh: false });
    let acknowledged = 0;
    const items = res.items ?? [];
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i]!;
      const result = items[i]?.index;
      // 409 = ES already holds this or a newer version: the document is up to date.
      const ok = result && (!result.error || result.status === 409);
      if (ok) {
        await this.deps.db.email.updateMany({
          where: { id: email.id, indexedVersion: { lt: email.version } },
          data: { indexedVersion: email.version },
        });
        acknowledged++;
      } else if (result?.error) {
        this.deps.logger.warn({ emailId: email.id, reason: result.error.type }, 'search index item failed');
      }
    }
    return acknowledged;
  }
}
