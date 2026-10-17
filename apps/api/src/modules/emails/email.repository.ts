import type { EmailStatus, Prisma } from '@prisma/client';
import type { Db } from '../../lib/prisma.js';
import { canTransition } from './status.js';

export interface TransitionInput {
  emailId: string;
  /** The row must currently be in one of these states (optimistic concurrency guard). */
  from: readonly EmailStatus[];
  to: EmailStatus;
  /** When set, the row must also hold this claim token (only the claiming worker may advance it). */
  claimToken?: string;
  data?: Omit<Prisma.EmailUpdateManyMutationInput, 'status' | 'version'>;
  message?: string;
}

/**
 * The only way email status changes. A conditional UPDATE ... WHERE status IN (...)
 * makes each transition atomic: if two workers race, exactly one sees count === 1.
 * Every change bumps `version` (search reindex trigger) and appends an audit event in the
 * same transaction. Transitions not allowed by the lifecycle table are a programming error.
 */
export async function transitionEmail(db: Db, input: TransitionInput): Promise<boolean> {
  const invalid = input.from.filter((from) => !canTransition(from, input.to));
  if (invalid.length > 0) {
    throw new Error(`Illegal email status transition ${invalid.join('|')} -> ${input.to}`);
  }
  return db.$transaction(async (tx) => {
    const res = await tx.email.updateMany({
      where: {
        id: input.emailId,
        status: { in: [...input.from] },
        ...(input.claimToken ? { claimToken: input.claimToken } : {}),
      },
      data: { ...input.data, status: input.to, version: { increment: 1 } },
    });
    if (res.count !== 1) return false;
    await tx.emailEvent.create({
      data: { emailId: input.emailId, status: input.to, message: input.message?.slice(0, 500) ?? null },
    });
    return true;
  });
}
