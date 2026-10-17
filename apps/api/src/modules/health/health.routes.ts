import { Router } from 'express';
import type { Client } from '@elastic/elasticsearch';
import type { Redis } from 'ioredis';
import type { Db } from '../../lib/prisma.js';

async function timed(check: () => Promise<unknown>) {
  const start = Date.now();
  try {
    await Promise.race([
      check(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3_000)),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: (err as Error).message.slice(0, 120) };
  }
}

export function healthRouter(deps: { db: Db; redis: Redis; es: Client }): Router {
  const r = Router();

  /** Liveness: the process is up. */
  r.get('/', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  /**
   * Readiness: PostgreSQL and Redis are required (503 without them). Elasticsearch is
   * reported but optional — search degrades to a database fallback while it is down.
   */
  r.get('/ready', async (_req, res) => {
    const [database, redis, elasticsearch] = await Promise.all([
      timed(() => deps.db.$queryRaw`SELECT 1`),
      timed(() => deps.redis.ping()),
      timed(() => deps.es.ping()),
    ]);
    const ready = database.ok && redis.ok;
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'degraded', checks: { database, redis, elasticsearch } });
  });

  return r;
}
