import type { Redis } from 'ioredis';

/**
 * Distributed hourly quota with ahead-of-time window reservation.
 *
 * Semantics
 * - Fixed windows aligned to the Unix epoch (1h windows == UTC clock hours, e.g. 14:00:00.000–14:59:59.999Z).
 * - Time comes from Redis `TIME`, so worker clock skew cannot split or stretch a window.
 * - A reservation is taken for each SMTP *attempt* (not each success). Providers throttle on
 *   attempts, so counting attempts is the conservative choice. Retries are bounded by
 *   EMAIL_MAX_ATTEMPTS, so they cannot consume unbounded capacity.
 * - Each email holds at most one live reservation (`res:<emailId>`). Re-running the same job
 *   (stall recovery, re-delivery) reuses it instead of consuming more capacity.
 * - If the current window is full for any applicable limit (sender, global, optional batch),
 *   the script atomically books the first future window with room and returns it. The job is
 *   then delayed to that window, so it is never dropped or failed because of the quota, and
 *   FIFO order of processing becomes FIFO order of window booking.
 *
 * Leak handling
 * - Counters expire two windows after their window, so nothing leaks permanently.
 * - `release` returns capacity when an email is cancelled or fails before any SMTP attempt.
 * - `consume` marks the reservation used after an SMTP attempt (capacity stays counted).
 *
 * Limitation: keys are derived inside the script, which is fine on a single Redis node or
 * a primary/replica setup, but is not Redis Cluster compatible without hash tags.
 */

const RESERVE_LUA = `
local prefix = ARGV[1]
local emailId = ARGV[2]
local senderId = ARGV[3]
local batchId = ARGV[4]
local senderLimit = tonumber(ARGV[5])
local globalLimit = tonumber(ARGV[6])
local batchLimit = tonumber(ARGV[7])
local windowMs = tonumber(ARGV[8])
local notBefore = tonumber(ARGV[9])
local maxAhead = tonumber(ARGV[10])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local current = math.floor(now / windowMs)
local resKey = prefix .. 'res:' .. emailId

local existing = redis.call('GET', resKey)
if existing then
  local sep = string.find(existing, ':', 1, true)
  local w = tonumber(string.sub(existing, 1, sep - 1))
  local pos = tonumber(string.sub(existing, sep + 1))
  if w >= current then
    return {w, pos, now, current, 1, ''}
  end
  -- The reserved window passed without a send (e.g. long outage). Capacity in the old
  -- window stays counted (it may have been attempted); take a fresh reservation.
  redis.call('DEL', resKey)
end

local startW = math.max(current, math.floor(notBefore / windowMs))
local blockedNow = ''
for i = 0, maxAhead do
  local w = startW + i
  local sk = prefix .. 'sender:' .. senderId .. ':' .. w
  local gk = prefix .. 'global:' .. w
  local bk = prefix .. 'batch:' .. batchId .. ':' .. w
  local sc = tonumber(redis.call('GET', sk) or '0')
  local gc = tonumber(redis.call('GET', gk) or '0')
  local bc = 0
  if batchLimit > 0 then bc = tonumber(redis.call('GET', bk) or '0') end

  if sc < senderLimit and gc < globalLimit and (batchLimit == 0 or bc < batchLimit) then
    local ttl = (w + 2) * windowMs - now
    local pos = redis.call('INCR', sk) - 1
    redis.call('PEXPIRE', sk, ttl)
    redis.call('INCR', gk)
    redis.call('PEXPIRE', gk, ttl)
    if batchLimit > 0 then
      redis.call('INCR', bk)
      redis.call('PEXPIRE', bk, ttl)
    end
    redis.call('SET', resKey, w .. ':' .. pos, 'PX', ttl)
    return {w, pos, now, current, 0, blockedNow}
  end

  if i == 0 and w == current then
    local parts = {}
    if sc >= senderLimit then table.insert(parts, 'SENDER') end
    if gc >= globalLimit then table.insert(parts, 'GLOBAL') end
    if batchLimit > 0 and bc >= batchLimit then table.insert(parts, 'BATCH') end
    blockedNow = table.concat(parts, ',')
  end
end
return {-1, 0, now, current, 0, blockedNow}
`;

const RELEASE_LUA = `
local prefix = ARGV[1]
local emailId = ARGV[2]
local senderId = ARGV[3]
local batchId = ARGV[4]
local resKey = prefix .. 'res:' .. emailId
local existing = redis.call('GET', resKey)
if not existing then return 0 end
local sep = string.find(existing, ':', 1, true)
local w = string.sub(existing, 1, sep - 1)
local keys = { prefix .. 'sender:' .. senderId .. ':' .. w, prefix .. 'global:' .. w, prefix .. 'batch:' .. batchId .. ':' .. w }
for _, k in ipairs(keys) do
  local v = tonumber(redis.call('GET', k) or '0')
  if v > 0 then redis.call('DECR', k) end
end
redis.call('DEL', resKey)
return 1
`;

export type LimitType = 'SENDER' | 'GLOBAL' | 'BATCH';

export interface QuotaRequest {
  emailId: string;
  senderId: string;
  batchId: string;
  /** Earliest time the email may be sent (its scheduledAt), epoch ms. */
  notBeforeMs: number;
  senderLimit: number;
  globalLimit: number;
  /** Optional per-batch hourly limit chosen in the compose form. */
  batchLimit: number | null;
}

export interface QuotaReservation {
  /** Reserved window index, or null if no window within the look-ahead horizon had room. */
  window: number | null;
  /** 0-based position of this reservation inside the sender's window (used to stagger wake-ups). */
  position: number;
  nowMs: number;
  currentWindow: number;
  reused: boolean;
  /** Limits that were already exhausted in the current window when this call was made. */
  blockedNow: LimitType[];
  windowMs: number;
}

export class HourlyQuota {
  constructor(
    private readonly redis: Redis,
    private readonly opts: { prefix: string; windowMs: number; maxWindowsAhead?: number },
  ) {}

  private get keyPrefix() {
    return `${this.opts.prefix}:rl:`;
  }

  async reserve(req: QuotaRequest): Promise<QuotaReservation> {
    const raw = (await this.redis.eval(
      RESERVE_LUA,
      0,
      this.keyPrefix,
      req.emailId,
      req.senderId,
      req.batchId,
      req.senderLimit,
      req.globalLimit,
      req.batchLimit ?? 0,
      this.opts.windowMs,
      req.notBeforeMs,
      this.opts.maxWindowsAhead ?? 24 * 14,
    )) as [number, number, number, number, number, string];
    const [window, position, nowMs, currentWindow, reused, blocked] = raw;
    return {
      window: window < 0 ? null : window,
      position,
      nowMs,
      currentWindow,
      reused: reused === 1,
      blockedNow: blocked ? (blocked.split(',') as LimitType[]) : [],
      windowMs: this.opts.windowMs,
    };
  }

  /** Return capacity for an email that will never be attempted (cancelled / failed pre-SMTP). */
  async release(emailId: string, senderId: string, batchId: string): Promise<boolean> {
    const res = await this.redis.eval(RELEASE_LUA, 0, this.keyPrefix, emailId, senderId, batchId);
    return res === 1;
  }

  /** Mark the reservation as spent by an SMTP attempt; the next attempt must reserve again. */
  async consume(emailId: string): Promise<void> {
    await this.redis.del(`${this.keyPrefix}res:${emailId}`);
  }

  async usage(senderId: string, window: number): Promise<{ sender: number; global: number }> {
    const [s, g] = await this.redis.mget(
      `${this.keyPrefix}sender:${senderId}:${window}`,
      `${this.keyPrefix}global:${window}`,
    );
    return { sender: Number(s ?? 0), global: Number(g ?? 0) };
  }
}
