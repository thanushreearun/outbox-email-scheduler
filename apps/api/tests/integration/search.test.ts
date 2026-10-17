import type { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { logger } from '../../src/lib/logger.js';
import { createSearchClient, ensureEmailIndex } from '../../src/modules/search/search.client.js';
import { SearchIndexer } from '../../src/modules/search/search.indexer.js';
import { SearchService } from '../../src/modules/search/search.service.js';
import { transitionEmail } from '../../src/modules/emails/email.repository.js';
import { createEmail, createUser, db, resetDatabase } from '../helpers.js';

const es = createSearchClient();
const esAvailable = await es.ping().then(
  () => true,
  () => false,
);

beforeEach(resetDatabase);
afterAll(async () => {
  if (esAvailable) await es.indices.delete({ index: env.ELASTICSEARCH_INDEX }).catch(() => undefined);
  await es.close();
  await db.$disconnect();
});

describe('indexing reliability (fake ES)', () => {
  it('a failed index call leaves the row dirty; reconcile indexes it later', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    const broken = {
      bulk: vi.fn(async () => {
        throw new Error('ES down');
      }),
    } as unknown as Client;
    await new SearchIndexer({ db, es: broken, logger }).syncEmails([email.id]); // must not throw
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).indexedVersion).toBe(0);

    const healthy = {
      bulk: vi.fn(async ({ operations }: { operations: unknown[] }) => ({
        items: Array.from({ length: operations.length / 2 }, () => ({ index: { status: 201 } })),
      })),
    } as unknown as Client;
    expect(await new SearchIndexer({ db, es: healthy, logger }).reconcile()).toBe(1);
    const row = await db.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.indexedVersion).toBe(row.version);
  });

  it('status changes bump the version so the document is re-indexed', async () => {
    const { user, sender } = await createUser();
    const email = await createEmail({ userId: user.id, senderId: sender.id });
    await db.email.update({ where: { id: email.id }, data: { indexedVersion: 1 } });
    await transitionEmail(db, { emailId: email.id, from: ['SCHEDULED'], to: 'CANCELLED' });
    const row = await db.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(row.version).toBe(2);
    expect(row.indexedVersion).toBe(1);
  });
});

describe.skipIf(!esAvailable)('Elasticsearch (real cluster)', () => {
  beforeAll(async () => {
    await es.indices.delete({ index: env.ELASTICSEARCH_INDEX }).catch(() => undefined);
    expect(await ensureEmailIndex(es, logger)).toBe(true);
  });

  it('indexes with external versions and scopes search to the user', async () => {
    const a = await createUser();
    const b = await createUser();
    const e1 = await createEmail({
      userId: a.user.id,
      senderId: a.sender.id,
      recipient: 'john.smith@acme.io',
    });
    const e2 = await createEmail({ userId: b.user.id, senderId: b.sender.id, recipient: 'john.doe@acme.io' });
    const indexer = new SearchIndexer({ db, es, logger });
    await indexer.syncEmails([e1.id, e2.id]);
    await es.indices.refresh({ index: env.ELASTICSEARCH_INDEX });

    const search = new SearchService({ es, db, logger });
    const byPart = await search.search({ userId: a.user.id, q: 'acme', page: 1, pageSize: 10 });
    expect(byPart.source).toBe('elasticsearch');
    expect(byPart.ids).toEqual([e1.id]);
    const exact = await search.search({ userId: b.user.id, q: 'john.doe@acme.io', page: 1, pageSize: 10 });
    expect(exact.ids).toEqual([e2.id]);
    const prefix = await search.search({ userId: a.user.id, q: 'Hel', page: 1, pageSize: 10 }); // subject "Hello"
    expect(prefix.ids).toEqual([e1.id]);

    // A stale (lower-version) write can never overwrite a newer document.
    await transitionEmail(db, { emailId: e1.id, from: ['SCHEDULED'], to: 'CANCELLED' });
    await indexer.syncEmails([e1.id]);
    await es
      .index({
        index: env.ELASTICSEARCH_INDEX,
        id: e1.id,
        version: 1,
        version_type: 'external',
        document: { userId: a.user.id, status: 'SCHEDULED' },
      })
      .catch(() => undefined);
    const doc = await es.get<{ status: string }>({ index: env.ELASTICSEARCH_INDEX, id: e1.id });
    expect(doc._source!.status).toBe('CANCELLED');
    await es.indices.refresh({ index: env.ELASTICSEARCH_INDEX });

    const filtered = await search.search({
      userId: a.user.id,
      q: '',
      statuses: ['SCHEDULED'],
      page: 1,
      pageSize: 10,
    });
    expect(filtered.ids).toEqual([]);
  });
});
