import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { closeSharedRedis, sharedRedis } from '../../src/lib/redis.js';
import { HourlyQuota } from '../../src/queue/rate-limiter.js';
import { SendSpacer, SPACING_TOLERANCE_MS } from '../../src/queue/spacing.js';
import { resetRedis } from '../helpers.js';

const redis = sharedRedis();
const WINDOW = 3_600_000;
const quota = new HourlyQuota(redis, { prefix: env.QUEUE_PREFIX, windowMs: WINDOW, maxWindowsAhead: 48 });
const base = {
  senderId: 'sender-a',
  batchId: 'batch-1',
  notBeforeMs: 0,
  senderLimit: 3,
  globalLimit: 100,
  batchLimit: null,
};

beforeEach(resetRedis);
afterAll(async () => {
  await resetRedis();
  await closeSharedRedis();
});

describe('HourlyQuota (Redis Lua, real Redis)', () => {
  it('reserves in the current window until the sender limit, then books the next window in order', async () => {
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await quota.reserve({ ...base, emailId: `e${i}` }));
    const current = results[0]!.currentWindow;
    expect(results.map((r) => r.window! - current)).toEqual([0, 0, 0, 1, 1, 1, 2]);
    expect(results.map((r) => r.position)).toEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(results[3]!.blockedNow).toEqual(['SENDER']);
    expect(results[0]!.blockedNow).toEqual([]);
  });

  it('is idempotent per email: re-running a job reuses its reservation instead of consuming more', async () => {
    const a = await quota.reserve({ ...base, emailId: 'same' });
    const b = await quota.reserve({ ...base, emailId: 'same' });
    expect(b.reused).toBe(true);
    expect(b.window).toBe(a.window);
    expect((await quota.usage('sender-a', a.window!)).sender).toBe(1);
  });

  it('concurrent workers cannot exceed the shared limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => quota.reserve({ ...base, senderLimit: 10, emailId: `c${i}` })),
    );
    const current = results[0]!.currentWindow;
    expect(results.filter((r) => r.window === current)).toHaveLength(10);
    expect(results.filter((r) => r.window === current + 1)).toHaveLength(10);
    expect((await quota.usage('sender-a', current)).sender).toBe(10);
    // Positions in each window are unique (no double-booked slot).
    const positions = results
      .filter((r) => r.window === current)
      .map((r) => r.position)
      .sort((x, y) => x - y);
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('enforces the global limit across different senders', async () => {
    const r1 = await quota.reserve({ ...base, globalLimit: 2, senderId: 's1', emailId: 'g1' });
    const r2 = await quota.reserve({ ...base, globalLimit: 2, senderId: 's2', emailId: 'g2' });
    const r3 = await quota.reserve({ ...base, globalLimit: 2, senderId: 's3', emailId: 'g3' });
    expect(r1.window).toBe(r1.currentWindow);
    expect(r2.window).toBe(r1.currentWindow);
    expect(r3.window).toBe(r1.currentWindow + 1);
    expect(r3.blockedNow).toEqual(['GLOBAL']);
  });

  it('applies an optional per-batch limit independently of the sender limit', async () => {
    const r = [];
    for (let i = 0; i < 3; i++)
      r.push(await quota.reserve({ ...base, senderLimit: 100, batchLimit: 2, emailId: `b${i}` }));
    expect(r[2]!.window).toBe(r[0]!.currentWindow + 1);
    expect(r[2]!.blockedNow).toEqual(['BATCH']);
    const other = await quota.reserve({
      ...base,
      senderLimit: 100,
      batchLimit: 2,
      batchId: 'batch-2',
      emailId: 'other',
    });
    expect(other.window).toBe(other.currentWindow);
  });

  it('release returns capacity (no leak for cancelled / pre-SMTP failures); consume keeps it counted', async () => {
    const a = await quota.reserve({ ...base, emailId: 'r1' });
    await quota.reserve({ ...base, emailId: 'r2' });
    expect(await quota.release('r1', 'sender-a', 'batch-1')).toBe(true);
    expect((await quota.usage('sender-a', a.window!)).sender).toBe(1);
    await quota.consume('r2');
    expect((await quota.usage('sender-a', a.window!)).sender).toBe(1);
    // After consume, a retry of r2 takes a NEW reservation (each SMTP attempt counts).
    await quota.reserve({ ...base, emailId: 'r2' });
    expect((await quota.usage('sender-a', a.window!)).sender).toBe(2);
  });

  it('does not reserve before the email is due (notBefore in a later window)', async () => {
    const future = Date.now() + 3 * WINDOW;
    const r = await quota.reserve({ ...base, emailId: 'f', notBeforeMs: future });
    expect(r.window).toBe(Math.floor(future / WINDOW));
  });

  it('counter keys expire (no permanent capacity leak)', async () => {
    const r = await quota.reserve({ ...base, emailId: 'ttl' });
    const ttl = await redis.pttl(`${env.QUEUE_PREFIX}:rl:sender:sender-a:${r.window}`);
    expect(ttl).toBeGreaterThan(WINDOW);
    expect(ttl).toBeLessThanOrEqual(2 * WINDOW);
  });
});

describe('SendSpacer (cross-worker minimum delay)', () => {
  it('spaces concurrent sends from one sender by at least the minimum delay', async () => {
    const spacer = new SendSpacer(redis, env.QUEUE_PREFIX);
    const delay = 150;
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        await spacer.waitForTurn('sender-x', `sp${i}`, delay);
        starts.push(Date.now());
      }),
    );
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      // Local timer resolution tolerance of a few ms on top of the Redis-clock guarantee.
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(delay - 15);
    }
    expect(starts[4]! - starts[0]!).toBeGreaterThanOrEqual(4 * delay);
    expect(starts[4]! - starts[0]!).toBeLessThan(4 * (delay + SPACING_TOLERANCE_MS) + 500);
  });

  it('different senders do not wait for each other', async () => {
    const spacer = new SendSpacer(redis, env.QUEUE_PREFIX);
    const t0 = Date.now();
    await Promise.all(['s1', 's2', 's3'].map((s) => spacer.waitForTurn(s, `d-${s}`, 1_000)));
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a woken job that is too late takes a fresh slot instead of crowding the next one', async () => {
    let stalls = 0;
    const spacer = new SendSpacer(redis, env.QUEUE_PREFIX, async (ms) => {
      // Simulate an event-loop stall: sleep 600 ms longer than asked.
      stalls++;
      await new Promise((r) => setTimeout(r, ms + 600));
    });
    const delay = 100;
    const first = await spacer.waitForTurn('stall', 'first', delay);
    const second = await spacer.waitForTurn('stall', 'second', delay);
    expect(stalls).toBeGreaterThanOrEqual(1);
    // The originally booked slot was first + delay + tolerance. Waking 600 ms late is past
    // the tolerance, so the worker must have taken a fresh, later slot (both Redis-clock values).
    expect(second - first).toBeGreaterThanOrEqual(delay + SPACING_TOLERANCE_MS + 400);
  });
});
