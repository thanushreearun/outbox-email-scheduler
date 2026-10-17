import { Router, type Request } from 'express';
import { z } from 'zod';
import { pageMeta } from '../../lib/pagination.js';
import { currentUser } from '../../middleware/auth.js';
import type { SearchService } from '../search/search.service.js';
import type { EmailService, EmailView } from './email.service.js';
import {
  idempotencyKeySchema,
  listQuerySchema,
  scheduleBatchSchema,
  scheduleSingleSchema,
  searchQuerySchema,
} from './email.schemas.js';

const idParam = (req: Request) => z.string().uuid('Invalid email id').parse(req.params.id);

export function emailsRouter(deps: { emails: EmailService; search: SearchService }): Router {
  const r = Router();
  const { emails } = deps;

  /** Schedule a batch (bulk recipients). Requires an Idempotency-Key header. */
  r.post('/batch', async (req, res) => {
    const key = idempotencyKeySchema.parse(req.get('idempotency-key'));
    const input = scheduleBatchSchema.parse(req.body);
    const result = await emails.schedule(currentUser(req).id, key, input);
    res.status(result.replayed ? 200 : 201).json({ data: result });
  });

  /** Schedule a single email: a one-recipient batch with the same guarantees. */
  r.post('/', async (req, res) => {
    const key = idempotencyKeySchema.parse(req.get('idempotency-key'));
    const { to, toName, ...rest } = scheduleSingleSchema.parse(req.body);
    const result = await emails.schedule(currentUser(req).id, key, {
      ...rest,
      recipients: [{ email: to, name: toName ?? null }],
    });
    res.status(result.replayed ? 200 : 201).json({ data: result });
  });

  for (const view of ['scheduled', 'sent', 'failed'] as const satisfies readonly EmailView[]) {
    r.get(`/${view}`, async (req, res) => {
      const q = listQuerySchema.parse(req.query);
      res.json(await emails.list(currentUser(req).id, view, q));
    });
  }

  r.get('/counts', async (req, res) => {
    res.json({ data: await emails.counts(currentUser(req).id) });
  });

  r.get('/search', async (req, res) => {
    const q = searchQuerySchema.parse(req.query);
    const userId = currentUser(req).id;
    const result = await deps.search.search({
      userId,
      q: q.q,
      statuses: q.status,
      page: q.page,
      pageSize: q.pageSize,
    });
    res.json({
      data: await emails.hydrate(userId, result.ids),
      meta: { ...pageMeta(q.page, q.pageSize, result.total), source: result.source },
    });
  });

  r.get('/:id', async (req, res) => {
    res.json({ data: await emails.get(currentUser(req).id, idParam(req)) });
  });

  r.post('/:id/cancel', async (req, res) => {
    res.json({ data: await emails.cancel(currentUser(req).id, idParam(req)) });
  });

  return r;
}
