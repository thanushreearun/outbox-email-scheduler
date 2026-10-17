import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../../middleware/auth.js';
import type { SenderService } from './sender.service.js';

const displayName = z.string().trim().max(80).nullable().optional();

const smtpSchema = z.object({
  displayName,
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  user: z.string().trim().email('SMTP username must be the mailbox email address').max(254),
  pass: z.string().min(1).max(500),
});

const patchSchema = z
  .object({ displayName, isActive: z.boolean().optional() })
  .refine((v) => v.displayName !== undefined || v.isActive !== undefined, 'Nothing to update');

export function sendersRouter(senders: SenderService): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    res.json({ data: await senders.list(currentUser(req).id) });
  });

  r.post('/ethereal', async (req, res) => {
    const body = z.object({ displayName }).parse(req.body ?? {});
    res
      .status(201)
      .json({ data: await senders.createEthereal(currentUser(req).id, body.displayName ?? null) });
  });

  r.post('/smtp', async (req, res) => {
    const body = smtpSchema.parse(req.body);
    res.status(201).json({
      data: await senders.createSmtp(currentUser(req).id, { ...body, displayName: body.displayName ?? null }),
    });
  });

  r.patch('/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json({ data: await senders.update(currentUser(req).id, id, patchSchema.parse(req.body)) });
  });

  return r;
}
