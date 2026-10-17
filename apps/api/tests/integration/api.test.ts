import { randomUUID } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createContainer } from '../../src/container.js';
import { logger } from '../../src/lib/logger.js';
import { closeSharedRedis } from '../../src/lib/redis.js';
import { csrfTokenFor } from '../../src/middleware/csrf.js';
import { SessionService } from '../../src/modules/auth/session.service.js';
import { EmailService } from '../../src/modules/emails/email.service.js';
import { SearchIndexer } from '../../src/modules/search/search.indexer.js';
import { SearchService } from '../../src/modules/search/search.service.js';
import { SenderService } from '../../src/modules/senders/sender.service.js';
import { closeQueues, emailJobId, type EmailJobData } from '../../src/queue/queues.js';
import { OutboxReconciler } from '../../src/queue/reconciler.js';
import { createUser, db, FakeMailer, resetDatabase, resetRedis } from '../helpers.js';

const fakeEs = {
  bulk: vi.fn(async ({ operations }: { operations: unknown[] }) => ({
    items: Array.from({ length: operations.length / 2 }, () => ({ index: { status: 201 } })),
  })),
  search: vi.fn(),
  ping: vi.fn(async () => true),
  close: vi.fn(async () => undefined),
  indices: { exists: vi.fn(async () => true), create: vi.fn() },
} as unknown as Client & { search: ReturnType<typeof vi.fn> };

const base = createContainer();
const c = {
  ...base,
  es: fakeEs,
  mailer: new FakeMailer() as unknown as typeof base.mailer,
  indexer: new SearchIndexer({ db, es: fakeEs, logger }),
  search: new SearchService({ db, es: fakeEs, logger }),
};
const app = createApp(c);
const sessions = new SessionService(db);

async function login(userId: string) {
  const s = await sessions.create(userId, 'vitest');
  return { cookie: `outbox_sid=${s.token}`, csrf: csrfTokenFor(s.sessionId) };
}

const future = (ms = 60 * 60_000) => new Date(Date.now() + ms).toISOString();

function batchBody(senderAccountId: string, overrides: Record<string, unknown> = {}) {
  return {
    senderAccountId,
    recipients: [
      { email: 'Ada@Example.com', name: 'Ada' },
      { email: 'alan@example.com' },
      { email: 'ada@example.com' },
      { email: 'broken-address' },
    ],
    subject: 'Quarterly update',
    bodyHtml: '<p>Hello <strong>there</strong><script>alert(1)</script></p>',
    startAt: future(),
    delayBetweenMs: 5000,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
  await resetRedis();
  fakeEs.search.mockReset();
});
afterAll(async () => {
  await resetRedis();
  await closeQueues(c.queues);
  await closeSharedRedis();
  await db.$disconnect();
});

describe('authentication & CSRF', () => {
  it('rejects unauthenticated requests', async () => {
    await request(app).get('/api/me').expect(401);
    await request(app).get('/api/emails/scheduled').expect(401);
    const res = await request(app).post('/api/emails/batch').send({}).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the session user and a CSRF token', async () => {
    const { user } = await createUser('oliver@example.com');
    const auth = await login(user.id);
    const res = await request(app).get('/api/me').set('Cookie', auth.cookie).expect(200);
    expect(res.body.data.user.email).toBe('oliver@example.com');
    expect(res.body.data.csrfToken).toBe(auth.csrf);
  });

  it('rejects state-changing requests without a valid CSRF token or from a foreign origin', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const noToken = await request(app)
      .post('/api/emails/batch')
      .set('Cookie', auth.cookie)
      .send(batchBody(sender.id))
      .expect(403);
    expect(noToken.body.error.code).toBe('CSRF_TOKEN');
    const foreign = await request(app)
      .post('/api/emails/batch')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .set('Origin', 'https://evil.example')
      .send(batchBody(sender.id))
      .expect(403);
    expect(foreign.body.error.code).toBe('CSRF_ORIGIN');
  });

  it('logout invalidates the session server-side', async () => {
    const { user } = await createUser();
    const auth = await login(user.id);
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .expect(204);
    await request(app).get('/api/me').set('Cookie', auth.cookie).expect(401);
  });
});

describe('session housekeeping', () => {
  it('purges expired sessions and OAuth states but keeps live sessions', async () => {
    const { user } = await createUser();
    const live = await login(user.id);
    await db.session.create({
      data: { tokenHash: 'expired-hash', userId: user.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await db.oAuthState.create({
      data: { stateHash: 'old-state', provider: 'GOOGLE', expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await sessions.purgeExpired()).toEqual({ sessions: 1, oauthStates: 1 });
    await request(app).get('/api/me').set('Cookie', live.cookie).expect(200);
  });
});

describe('scheduling API', () => {
  function post(auth: { cookie: string; csrf: string }, body: unknown, key: string | null = randomUUID()) {
    const req = request(app)
      .post('/api/emails/batch')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf);
    if (key) req.set('Idempotency-Key', key);
    return req.send(body as object);
  }

  it('validates, de-duplicates, persists and enqueues delayed jobs', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const res = await post(auth, batchBody(sender.id)).expect(201);
    const d = res.body.data;
    expect(d).toMatchObject({
      replayed: false,
      totalSubmitted: 4,
      accepted: 2,
      duplicatesRemoved: 1,
      effectiveDelayMs: 5000,
    });
    expect(d.rejected).toEqual([{ input: 'broken-address', reason: 'Missing "@"' }]);
    expect(d.enqueue).toEqual({ enqueued: 2, pendingReconciliation: 0 });

    const rows = await db.email.findMany({ where: { userId: user.id }, orderBy: { scheduledAt: 'asc' } });
    expect(rows.map((r) => r.recipientEmail)).toEqual(['ada@example.com', 'alan@example.com']);
    expect(rows[1]!.scheduledAt.getTime() - rows[0]!.scheduledAt.getTime()).toBe(5000);
    expect(rows.every((r) => r.enqueuedAt !== null && r.status === 'SCHEDULED')).toBe(true);

    const batch = await db.emailBatch.findFirstOrThrow({ where: { userId: user.id } });
    expect(batch.bodyHtml).not.toContain('script');

    for (const r of rows) {
      expect(await c.queues.email.getJobState(emailJobId(r.id))).toBe('delayed');
      const job = await c.queues.email.getJob(emailJobId(r.id));
      expect(job!.data).toEqual({ emailId: r.id }); // no PII in Redis
      expect(Math.abs(job!.timestamp + job!.opts.delay! - r.scheduledAt.getTime())).toBeLessThan(2000);
    }
  });

  it('is idempotent for repeated requests with the same key', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const key = randomUUID();
    const body = batchBody(sender.id);
    const first = await post(auth, body, key).expect(201);
    const second = await post(auth, body, key).expect(200);
    expect(second.body.data.replayed).toBe(true);
    expect(second.body.data.batchId).toBe(first.body.data.batchId);
    expect(await db.email.count({ where: { userId: user.id } })).toBe(2);
    expect(await c.queues.email.getDelayedCount()).toBe(2);
  });

  it('handles concurrent duplicate submissions without duplicating rows', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const key = randomUUID();
    const body = batchBody(sender.id);
    const results = await Promise.all([post(auth, body, key), post(auth, body, key), post(auth, body, key)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body.data.batchId)).size).toBe(1);
    expect(await db.email.count({ where: { userId: user.id } })).toBe(2);
  });

  it('rejects reuse of an Idempotency-Key with a different payload', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const key = randomUUID();
    await post(auth, batchBody(sender.id), key).expect(201);
    const res = await post(auth, batchBody(sender.id, { subject: 'Different' }), key).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid requests with field-level details', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    await post(auth, batchBody(sender.id), null).expect(400);
    const past = await post(
      auth,
      batchBody(sender.id, { startAt: new Date(Date.now() - 3_600_000).toISOString() }),
    ).expect(400);
    expect(past.body.error.details).toEqual([{ path: 'startAt', message: 'startAt is in the past' }]);
    await post(auth, batchBody(sender.id, { recipients: [] })).expect(400);
    await post(auth, batchBody(sender.id, { hourlyLimit: 100_000 })).expect(400);
    const allBad = await post(auth, batchBody(sender.id, { recipients: [{ email: 'nope' }] })).expect(400);
    expect(allBad.body.error.message).toBe('No valid recipients');
    expect(await db.email.count()).toBe(0);
  });

  it('never turns a missing or invalid startAt into an immediate send', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const { startAt: _omit, ...withoutStartAt } = batchBody(sender.id);
    for (const body of [
      withoutStartAt,
      batchBody(sender.id, { startAt: null }),
      batchBody(sender.id, { startAt: '' }),
      batchBody(sender.id, { startAt: 'tomorrow 10am' }),
      batchBody(sender.id, { startAt: '2030-01-01T10:00:00' }), // no timezone: ambiguous
    ]) {
      const res = await post(auth, body).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    expect(await db.email.count()).toBe(0);
    expect(await c.queues.email.count()).toBe(0);
  });

  it('stores a future startAt exactly and delays the job until then', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const startAt = new Date(Date.now() + 10 * 60_000);
    await post(auth, batchBody(sender.id, { startAt: startAt.toISOString() })).expect(201);
    const first = await db.email.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { scheduledAt: 'asc' },
    });
    expect(first.scheduledAt.toISOString()).toBe(startAt.toISOString());
    const job = await c.queues.email.getJob(emailJobId(first.id));
    expect(await job!.getState()).toBe('delayed');
    expect(job!.opts.delay).toBeGreaterThan(9 * 60_000);
  });

  it('an explicit send-now (startAt = current time) is enqueued without delay', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    await post(
      auth,
      batchBody(sender.id, { startAt: new Date().toISOString(), recipients: [{ email: 'now@example.com' }] }),
    ).expect(201);
    const email = await db.email.findFirstOrThrow({ where: { userId: user.id } });
    const job = await c.queues.email.getJob(emailJobId(email.id));
    expect(job!.opts.delay).toBeLessThan(1_000);
  });

  it('accepts the single-email endpoint', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    const res = await request(app)
      .post('/api/emails')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .set('Idempotency-Key', randomUUID())
      .send({
        senderAccountId: sender.id,
        to: 'solo@example.com',
        subject: 'One',
        bodyHtml: '<p>Hi</p>',
        startAt: future(),
      })
      .expect(201);
    expect(res.body.data.accepted).toBe(1);
  });
});

describe('listing, ownership & cancellation', () => {
  async function scheduleFor(userId: string, senderId: string) {
    const auth = await login(userId);
    await request(app)
      .post('/api/emails/batch')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .set('Idempotency-Key', randomUUID())
      .send(batchBody(senderId))
      .expect(201);
    return auth;
  }

  it('lists scheduled and sent emails separately with pagination', async () => {
    const { user, sender } = await createUser();
    const auth = await scheduleFor(user.id, sender.id);
    const scheduled = await request(app)
      .get('/api/emails/scheduled?pageSize=1')
      .set('Cookie', auth.cookie)
      .expect(200);
    expect(scheduled.body.meta).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    expect(scheduled.body.data[0].recipientEmail).toBe('ada@example.com');
    expect(scheduled.body.data[0].snippet).toBe('Hello there');

    const empty = await request(app).get('/api/emails/sent').set('Cookie', auth.cookie).expect(200);
    expect(empty.body.data).toEqual([]);

    const one = await db.email.findFirstOrThrow({ where: { userId: user.id } });
    await db.email.update({ where: { id: one.id }, data: { status: 'SENT', sentAt: new Date() } });
    const sent = await request(app).get('/api/emails/sent').set('Cookie', auth.cookie).expect(200);
    expect(sent.body.data.map((e: { id: string }) => e.id)).toEqual([one.id]);
    const counts = await request(app).get('/api/emails/counts').set('Cookie', auth.cookie).expect(200);
    expect(counts.body.data).toMatchObject({ scheduled: 1, sent: 1 });
  });

  it('users cannot read, list, search or cancel another user’s emails', async () => {
    const a = await createUser();
    const b = await createUser();
    await scheduleFor(a.user.id, a.sender.id);
    const authB = await login(b.user.id);
    const emailA = await db.email.findFirstOrThrow({ where: { userId: a.user.id } });

    await request(app).get(`/api/emails/${emailA.id}`).set('Cookie', authB.cookie).expect(404);
    await request(app)
      .post(`/api/emails/${emailA.id}/cancel`)
      .set('Cookie', authB.cookie)
      .set('X-CSRF-Token', authB.csrf)
      .expect(404);
    const list = await request(app).get('/api/emails/scheduled').set('Cookie', authB.cookie).expect(200);
    expect(list.body.data).toEqual([]);

    // Even if the search engine returned a foreign ID, hydration re-applies the owner filter.
    fakeEs.search.mockResolvedValueOnce({ hits: { total: { value: 1 }, hits: [{ _id: emailA.id }] } });
    const search = await request(app).get('/api/emails/search?q=ada').set('Cookie', authB.cookie).expect(200);
    expect(search.body.data).toEqual([]);
    expect(fakeEs.search.mock.calls[0]![0].query.bool.filter).toContainEqual({ term: { userId: b.user.id } });

    // B cannot schedule with A's sender.
    await request(app)
      .post('/api/emails/batch')
      .set('Cookie', authB.cookie)
      .set('X-CSRF-Token', authB.csrf)
      .set('Idempotency-Key', randomUUID())
      .send(batchBody(a.sender.id))
      .expect(404);
  });

  it('cancels a scheduled email, removes its job, and refuses a second cancel', async () => {
    const { user, sender } = await createUser();
    const auth = await scheduleFor(user.id, sender.id);
    const email = await db.email.findFirstOrThrow({ where: { userId: user.id } });
    await request(app)
      .post(`/api/emails/${email.id}/cancel`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .expect(200);
    expect((await db.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe('CANCELLED');
    expect(await c.queues.email.getJobState(emailJobId(email.id))).toBe('unknown');
    await request(app)
      .post(`/api/emails/${email.id}/cancel`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .expect(409);
  });

  it('search falls back to PostgreSQL when Elasticsearch is unavailable', async () => {
    const { user, sender } = await createUser();
    const auth = await scheduleFor(user.id, sender.id);
    fakeEs.search.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await request(app).get('/api/emails/search?q=alan').set('Cookie', auth.cookie).expect(200);
    expect(res.body.meta.source).toBe('database');
    expect(res.body.data.map((e: { recipientEmail: string }) => e.recipientEmail)).toEqual([
      'alan@example.com',
    ]);
  });
});

describe('outbox recovery (database ↔ Redis dual write)', () => {
  it('rows whose enqueue failed are picked up by the reconciler with their original schedule', async () => {
    const { user, sender } = await createUser();
    const brokenQueue = {
      addBulk: vi.fn(async () => {
        throw new Error('Redis down');
      }),
    } as unknown as Queue<EmailJobData>;
    const service = new EmailService({
      db,
      queue: brokenQueue,
      logger,
      indexer: { syncSoon: () => undefined },
      quota: c.quota,
      senders: new SenderService({ db, mailer: new FakeMailer() }),
    });
    const result = await service.schedule(user.id, randomUUID(), {
      ...batchBody(sender.id),
      startAt: new Date(Date.now() + 3_600_000),
      attachmentIds: [],
    } as never);
    expect(result.enqueue).toEqual({ enqueued: 0, pendingReconciliation: 2 });
    expect(await db.email.count({ where: { enqueuedAt: null } })).toBe(2);

    const reconciler = new OutboxReconciler({ db, queue: c.queues.email, logger });
    expect(await reconciler.enqueuePending(0)).toBe(2);
    expect(await db.email.count({ where: { enqueuedAt: null } })).toBe(0);
    const rows = await db.email.findMany({ where: { userId: user.id } });
    for (const r of rows) {
      const job = await c.queues.email.getJob(emailJobId(r.id));
      expect(Math.abs(job!.timestamp + job!.opts.delay! - r.scheduledAt.getTime())).toBeLessThan(2000);
    }
    // Running it again is a no-op.
    expect(await reconciler.enqueuePending(0)).toBe(0);
  });

  it('jobs lost from Redis are re-created from PostgreSQL; failed jobs of pending rows are retried', async () => {
    const { user, sender } = await createUser();
    const auth = await login(user.id);
    await request(app)
      .post('/api/emails/batch')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .set('Idempotency-Key', randomUUID())
      .send(batchBody(sender.id))
      .expect(201);
    const [r1, r2] = await db.email.findMany({ where: { userId: user.id } });
    await c.queues.email.remove(emailJobId(r1!.id)); // simulate Redis data loss for one job

    const reconciler = new OutboxReconciler({ db, queue: c.queues.email, logger });
    const res = await reconciler.verifyJobs();
    expect(res).toEqual({ checked: 2, repaired: 1 });
    expect(await c.queues.email.getJobState(emailJobId(r1!.id))).toBe('delayed');
    expect(await c.queues.email.getJobState(emailJobId(r2!.id))).toBe('delayed');
  });
});
