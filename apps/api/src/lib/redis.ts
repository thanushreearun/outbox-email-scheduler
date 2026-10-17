import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` for blocking connections used by workers.
 * Separate connections are created for different roles so a blocking worker command
 * never stalls request-path commands.
 */
export function createRedis(role: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `outbox:${role}`,
  });
  client.on('error', (err) => logger.warn({ err: err.message, role }, 'redis connection error'));
  return client;
}

let shared: Redis | undefined;
/** Shared non-blocking connection for rate limiting, queue producers and health checks. */
export function sharedRedis(): Redis {
  shared ??= createRedis('shared');
  return shared;
}

export async function closeSharedRedis(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = undefined;
  }
}
