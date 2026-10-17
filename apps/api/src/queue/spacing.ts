import type { Redis } from 'ioredis';
import { sleep } from '../lib/time.js';

/**
 * Minimum delay between two sends from the same sender, enforced across every worker
 * process and every concurrency slot.
 *
 * Mechanism: an atomic Lua script hands out send "slots" per sender from a shared cursor
 * (`spacing:<senderId>`), using the Redis clock. Consecutive slots are at least
 * `minDelay + tolerance` apart. A worker may only start its SMTP send while
 * `slot <= redisNow <= slot + tolerance`; if it wakes later than that (event-loop stall,
 * GC pause), it takes a fresh slot. Therefore two send starts for one sender are never
 * closer than `minDelay` by the Redis clock.
 *
 * Waiting happens inline (bounded by concurrency × workers × delay) while BullMQ keeps the
 * job lock renewed. A crashed worker only wastes its slot, it never lets another send early.
 */
const SLOT_LUA = `
local key = ARGV[1]
local resKey = ARGV[2]
local spacing = tonumber(ARGV[3])
local tolerance = tonumber(ARGV[4])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local existing = redis.call('GET', resKey)
if existing then
  local slot = tonumber(existing)
  if slot + tolerance >= now then
    return {slot, now}
  end
end

local last = redis.call('GET', key)
local slot = now
if last then
  slot = math.max(now, tonumber(last) + spacing)
end
redis.call('SET', key, slot, 'PX', (slot - now) + spacing + 3600000)
redis.call('SET', resKey, slot, 'PX', (slot - now) + 3600000)
return {slot, now}
`;

export const SPACING_TOLERANCE_MS = 200;

export class SendSpacer {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly sleeper: (ms: number) => Promise<void> = sleep,
  ) {}

  private async slot(senderId: string, emailId: string, minDelayMs: number) {
    const [slot, now] = (await this.redis.eval(
      SLOT_LUA,
      0,
      `${this.prefix}:spacing:${senderId}`,
      `${this.prefix}:spres:${emailId}`,
      minDelayMs + SPACING_TOLERANCE_MS,
      SPACING_TOLERANCE_MS,
    )) as [number, number];
    return { slot, now };
  }

  /**
   * Resolves when this email may start its SMTP send. Returns the slot used (Redis epoch ms).
   */
  async waitForTurn(
    senderId: string,
    emailId: string,
    minDelayMs: number,
    maxIterations = 50,
  ): Promise<number> {
    if (minDelayMs <= 0) return Date.now();
    for (let i = 0; i < maxIterations; i++) {
      const { slot, now } = await this.slot(senderId, emailId, minDelayMs);
      if (now >= slot) return slot;
      await this.sleeper(slot - now);
    }
    throw new Error('Could not obtain a send slot (spacing contention too high)');
  }

  /** Called after the send attempt so a retry of the same email takes a fresh slot. */
  async done(emailId: string): Promise<void> {
    await this.redis.del(`${this.prefix}:spres:${emailId}`);
  }
}
