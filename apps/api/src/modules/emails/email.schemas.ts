import { z } from 'zod';
import { env } from '../../config/env.js';
import { paginationSchema } from '../../lib/pagination.js';

/** Clock-skew grace for "send now" requests whose startAt is a few seconds in the past. */
export const START_AT_GRACE_MS = 2 * 60_000;
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 3_600_000;

export const idempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .regex(/^[A-Za-z0-9_.:-]{8,128}$/, 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_.:-]');

const startAtSchema = z
  .string()
  .datetime({
    offset: true,
    message: 'startAt must be an ISO-8601 timestamp with a timezone (e.g. 2026-01-01T09:00:00Z)',
  })
  .transform((s) => new Date(s))
  .superRefine((d, ctx) => {
    const now = Date.now();
    if (d.getTime() < now - START_AT_GRACE_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startAt is in the past' });
    }
    if (d.getTime() > now + MAX_SCHEDULE_AHEAD_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'startAt cannot be more than a year ahead' });
    }
  });

const commonFields = {
  senderAccountId: z.string().uuid(),
  subject: z.string().trim().min(1, 'Subject is required').max(250),
  bodyHtml: z.string().min(1, 'Body is required').max(200_000, 'Body is too large (max 200 KB)'),
  startAt: startAtSchema,
  delayBetweenMs: z
    .number()
    .int()
    .min(
      env.MIN_DELAY_BETWEEN_EMAILS_MS,
      `delayBetweenMs cannot be below the server minimum (${env.MIN_DELAY_BETWEEN_EMAILS_MS} ms)`,
    )
    .max(3_600_000)
    .optional(),
  hourlyLimit: z
    .number()
    .int()
    .min(1)
    .max(
      env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      `hourlyLimit cannot exceed ${env.MAX_EMAILS_PER_HOUR_PER_SENDER}`,
    )
    .nullable()
    .optional(),
  attachmentIds: z.array(z.string().uuid()).max(5, 'At most 5 attachments').default([]),
};

export const scheduleBatchSchema = z.object({
  ...commonFields,
  recipients: z
    .array(z.object({ email: z.string().max(320), name: z.string().max(200).nullable().optional() }))
    .min(1, 'At least one recipient is required')
    .max(env.MAX_RECIPIENTS_PER_BATCH, `At most ${env.MAX_RECIPIENTS_PER_BATCH} recipients per batch`),
});

export const scheduleSingleSchema = z.object({
  ...commonFields,
  to: z.string().max(320),
  toName: z.string().max(200).nullable().optional(),
});

export type ScheduleBatchInput = z.infer<typeof scheduleBatchSchema>;

export const listQuerySchema = paginationSchema.extend({
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((v) => v.trim().toUpperCase()) : undefined))
    .pipe(
      z
        .array(z.enum(['SCHEDULED', 'PROCESSING', 'SENDING', 'RETRYING', 'SENT', 'FAILED', 'CANCELLED']))
        .optional(),
    ),
});

export const searchQuerySchema = listQuerySchema.extend({
  q: z.string().trim().max(200).default(''),
});
