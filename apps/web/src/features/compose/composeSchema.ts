import { z } from 'zod';
import type { PublicConfig } from '../../types/api';

const optionalInt = (min: number, max: number, label: string) =>
  z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : Number(v)),
    z
      .number({ invalid_type_error: `${label} must be a number` })
      .int(`${label} must be a whole number`)
      .min(min, `${label} must be at least ${min}`)
      .max(max, `${label} cannot exceed ${max}`)
      .optional(),
  );

export function bodyText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function makeComposeSchema(
  cfg: Pick<PublicConfig, 'minDelayBetweenEmailsMs' | 'maxEmailsPerHourPerSender' | 'maxRecipientsPerBatch'>,
) {
  const minDelaySec = Math.ceil(cfg.minDelayBetweenEmailsMs / 1000);
  return z.object({
    senderAccountId: z.string().min(1, 'Choose a sender'),
    recipients: z
      .array(z.object({ email: z.string(), name: z.string().nullable() }))
      .min(1, 'Add at least one recipient')
      .max(cfg.maxRecipientsPerBatch, `At most ${cfg.maxRecipientsPerBatch} recipients`),
    subject: z.string().trim().min(1, 'Subject is required').max(250, 'Subject is too long'),
    bodyHtml: z.string().refine((html) => bodyText(html).length > 0, 'Write a message'),
    delaySeconds: optionalInt(minDelaySec, 3600, 'Delay'),
    hourlyLimit: optionalInt(1, cfg.maxEmailsPerHourPerSender, 'Hourly limit'),
  });
}

export type ComposeValues = z.input<ReturnType<typeof makeComposeSchema>>;
export type ComposeOutput = z.output<ReturnType<typeof makeComposeSchema>>;
