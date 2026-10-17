import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Router } from 'express';
import { config } from '../../config/env.js';
import { currentUser } from '../../middleware/auth.js';
import type { Queues } from '../../queue/queues.js';
import type { EmailService } from '../emails/email.service.js';

export const BULL_BOARD_PATH = '/admin/queues';

/** Live Bull Board UI over the real queues. Mounted behind requireAuth + requireAdmin. */
export function bullBoardRouter(queues: Queues) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(queues.email, { readOnlyMode: false }), new BullMQAdapter(queues.maintenance)],
    serverAdapter,
    options: { uiConfig: { boardTitle: 'Outbox queues' } },
  });
  return serverAdapter.getRouter() as Router;
}

/** Per-user status counts from PostgreSQL, plus raw BullMQ counts for administrators. */
export function queueStatsRouter(deps: { queues: Queues; emails: EmailService }): Router {
  const r = Router();
  r.get('/stats', async (req, res) => {
    const user = currentUser(req);
    const counts = await deps.emails.counts(user.id);
    const isAdmin = config.adminEmails.has(user.email.toLowerCase());
    const queue = isAdmin
      ? await deps.queues.email.getJobCounts(
          'waiting',
          'delayed',
          'active',
          'completed',
          'failed',
          'prioritized',
        )
      : null;
    res.json({ data: { emails: counts, queue, dashboardPath: isAdmin ? BULL_BOARD_PATH : null } });
  });
  return r;
}
