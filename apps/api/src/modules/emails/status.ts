import type { EmailStatus } from '@prisma/client';

/**
 * Email status lifecycle.
 *
 *   SCHEDULED ──claim──▶ PROCESSING ──▶ SENDING ──▶ SENT
 *      ▲  │                 │  │            │
 *      │  └─cancel─▶ CANCELLED │            ├──transient──▶ RETRYING ──claim──▶ PROCESSING
 *      │                    │  │            └──permanent / attempts exhausted──▶ FAILED
 *      └──quota deferral────┘  └──sender inactive──▶ FAILED
 *
 * PROCESSING → PROCESSING is allowed: a worker that crashed before the SMTP step left no
 * side effects, so a new worker may re-claim it. SENDING is never re-claimed: while fresh
 * it may belong to a live worker (the job backs off); once older than every SMTP timeout it
 * means a crash mid-transaction, the provider may already have accepted the message, and
 * the email is marked FAILED / DELIVERY_UNCERTAIN instead of being re-sent (see docs/ARCHITECTURE.md).
 */
export const TRANSITIONS: Record<EmailStatus, readonly EmailStatus[]> = {
  SCHEDULED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PROCESSING', 'SCHEDULED', 'SENDING', 'FAILED'],
  SENDING: ['SENT', 'RETRYING', 'FAILED'],
  RETRYING: ['PROCESSING', 'CANCELLED'],
  SENT: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_STATUSES: readonly EmailStatus[] = ['SENT', 'FAILED', 'CANCELLED'];
export const PENDING_STATUSES: readonly EmailStatus[] = ['SCHEDULED', 'PROCESSING', 'SENDING', 'RETRYING'];
export const CLAIMABLE_STATUSES: readonly EmailStatus[] = ['SCHEDULED', 'RETRYING', 'PROCESSING'];
export const CANCELLABLE_STATUSES: readonly EmailStatus[] = ['SCHEDULED', 'RETRYING'];

export function canTransition(from: EmailStatus, to: EmailStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: EmailStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
