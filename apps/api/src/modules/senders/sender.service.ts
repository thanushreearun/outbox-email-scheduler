import nodemailer from 'nodemailer';
import type { SenderAccount } from '@prisma/client';
import { config } from '../../config/env.js';
import { encryptSecret } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import type { Db } from '../../lib/prisma.js';
import type { Mailer } from '../../integrations/mailer.js';

const MAX_SENDERS_PER_USER = 10;

export interface PublicSender {
  id: string;
  email: string;
  displayName: string | null;
  provider: SenderAccount['provider'];
  isActive: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export function toPublicSender(s: SenderAccount): PublicSender {
  return {
    id: s.id,
    email: s.email,
    displayName: s.displayName,
    provider: s.provider,
    isActive: s.isActive,
    verifiedAt: s.verifiedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * Sender identity policy: a sender's From address is always the mailbox the SMTP
 * credentials authenticate as. Users cannot type an arbitrary From address; they either
 * use the operator-configured Ethereal mailbox, deliberately create a new Ethereal
 * mailbox, or provide SMTP credentials that are verified with a live SMTP handshake.
 */
export class SenderService {
  constructor(
    private readonly deps: {
      db: Db;
      mailer: Pick<Mailer, 'verify'>;
      createTestAccount?: () => Promise<{
        user: string;
        pass: string;
        smtp: { host: string; port: number; secure: boolean };
      }>;
    },
  ) {}

  /** Gives each user access to the environment-configured Ethereal identity (no secret copied to the DB). */
  async ensureDefaultSender(userId: string, displayName: string): Promise<void> {
    if (!config.ethereal) return;
    const email = config.ethereal.user.toLowerCase();
    await this.deps.db.senderAccount.upsert({
      where: { userId_email: { userId, email } },
      create: {
        userId,
        email,
        displayName,
        provider: 'ETHEREAL_ENV',
        credentialRef: 'env',
        verifiedAt: new Date(),
      },
      update: {},
    });
  }

  async list(userId: string): Promise<PublicSender[]> {
    const rows = await this.deps.db.senderAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPublicSender);
  }

  async getOwned(userId: string, senderId: string): Promise<SenderAccount> {
    const sender = await this.deps.db.senderAccount.findFirst({ where: { id: senderId, userId } });
    if (!sender) throw notFound('Sender not found');
    return sender;
  }

  private async assertCapacity(userId: string) {
    const count = await this.deps.db.senderAccount.count({ where: { userId } });
    if (count >= MAX_SENDERS_PER_USER)
      throw badRequest(`A user can have at most ${MAX_SENDERS_PER_USER} senders`);
  }

  async createEthereal(userId: string, displayName: string | null): Promise<PublicSender> {
    await this.assertCapacity(userId);
    const create = this.deps.createTestAccount ?? (() => nodemailer.createTestAccount());
    let account;
    try {
      account = await create();
    } catch {
      throw new AppError(
        502,
        'ETHEREAL_UNAVAILABLE',
        'Could not create an Ethereal account. Try again later.',
      );
    }
    const row = await this.deps.db.senderAccount.create({
      data: {
        userId,
        email: account.user.toLowerCase(),
        displayName,
        provider: 'ETHEREAL',
        credentialRef: 'db',
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpSecure: account.smtp.secure,
        smtpUser: account.user,
        smtpPassEncrypted: encryptSecret(account.pass),
        verifiedAt: new Date(),
      },
    });
    return toPublicSender(row);
  }

  async createSmtp(
    userId: string,
    input: {
      displayName: string | null;
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
    },
  ): Promise<PublicSender> {
    await this.assertCapacity(userId);
    const email = input.user.toLowerCase();
    const existing = await this.deps.db.senderAccount.findUnique({
      where: { userId_email: { userId, email } },
    });
    if (existing) throw conflict('A sender with this address already exists');
    try {
      await this.deps.mailer.verify({
        host: input.host,
        port: input.port,
        secure: input.secure,
        user: input.user,
        pass: input.pass,
      });
    } catch (err) {
      throw new AppError(
        422,
        'SMTP_VERIFY_FAILED',
        `SMTP verification failed: ${(err as Error).message.slice(0, 200)}`,
      );
    }
    const row = await this.deps.db.senderAccount.create({
      data: {
        userId,
        email,
        displayName: input.displayName,
        provider: 'SMTP',
        credentialRef: 'db',
        smtpHost: input.host,
        smtpPort: input.port,
        smtpSecure: input.secure,
        smtpUser: input.user,
        smtpPassEncrypted: encryptSecret(input.pass),
        verifiedAt: new Date(),
      },
    });
    return toPublicSender(row);
  }

  async update(userId: string, senderId: string, patch: { displayName?: string | null; isActive?: boolean }) {
    await this.getOwned(userId, senderId);
    const row = await this.deps.db.senderAccount.update({ where: { id: senderId }, data: patch });
    return toPublicSender(row);
  }
}
