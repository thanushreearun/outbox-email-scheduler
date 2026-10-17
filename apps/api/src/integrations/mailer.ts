import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';
import type { SenderAccount } from '@prisma/client';
import { config } from '../config/env.js';
import { decryptSecret, sha256 } from '../lib/crypto.js';

export interface SmtpCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface OutgoingMessage {
  from: { name?: string | null; address: string };
  to: { name?: string | null; address: string };
  subject: string;
  html: string;
  text: string;
  /** Deterministic RFC 5322 Message-ID so receivers can de-duplicate a re-send. */
  messageId: string;
  attachments?: Array<{ filename: string; path: string; contentType: string }>;
}

export interface SendResult {
  messageId: string;
  response: string;
  previewUrl: string | null;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    public readonly kind: 'transient' | 'permanent',
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

export class SenderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenderConfigError';
  }
}

export function resolveCredentials(sender: SenderAccount): SmtpCredentials {
  if (sender.credentialRef === 'env') {
    if (!config.ethereal) {
      throw new SenderConfigError(
        'Sender uses environment SMTP credentials but ETHEREAL_USER/ETHEREAL_PASS are not set',
      );
    }
    return { ...config.ethereal, secure: config.ethereal.port === 465 };
  }
  if (!sender.smtpHost || !sender.smtpPort || !sender.smtpUser || !sender.smtpPassEncrypted) {
    throw new SenderConfigError('Sender is missing SMTP configuration');
  }
  return {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    user: sender.smtpUser,
    pass: decryptSecret(sender.smtpPassEncrypted),
  };
}

/**
 * Classifies Nodemailer/SMTP failures.
 * - 4xx SMTP replies and network-level failures are transient (retry with backoff).
 * - 5xx replies, envelope/message errors and authentication failures are permanent:
 *   retrying them only burns quota and can get the sender flagged.
 */
export function classifySmtpError(err: unknown): SmtpError {
  const e = err as { message?: string; code?: string; responseCode?: number };
  const message = (e.message ?? 'Unknown SMTP error').slice(0, 500);
  if (typeof e.responseCode === 'number') {
    if (e.responseCode >= 400 && e.responseCode < 500)
      return new SmtpError(message, 'transient', `SMTP_${e.responseCode}`);
    if (e.responseCode >= 500) return new SmtpError(message, 'permanent', `SMTP_${e.responseCode}`);
  }
  switch (e.code) {
    case 'EAUTH':
      return new SmtpError('SMTP authentication failed for sender', 'permanent', 'SMTP_AUTH');
    case 'EENVELOPE':
    case 'EMESSAGE':
      return new SmtpError(message, 'permanent', e.code);
    default:
      return new SmtpError(message, 'transient', e.code ?? 'SMTP_UNKNOWN');
  }
}

export interface Mailer {
  send(credentials: SmtpCredentials, message: OutgoingMessage): Promise<SendResult>;
  verify(credentials: SmtpCredentials): Promise<void>;
  close(): void;
}

/** Pools one SMTP transport per credential set; credentials are part of the cache key hash only. */
export class NodemailerMailer implements Mailer {
  private readonly transports = new Map<string, Transporter<SMTPPool.SentMessageInfo>>();

  private transportFor(c: SmtpCredentials): Transporter<SMTPPool.SentMessageInfo> {
    const key = sha256(`${c.host}|${c.port}|${c.secure}|${c.user}|${c.pass}`);
    let t = this.transports.get(key);
    if (!t) {
      t = nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        requireTLS: !c.secure,
        auth: { user: c.user, pass: c.pass },
        pool: true,
        maxConnections: 2,
        maxMessages: 100,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
      this.transports.set(key, t);
    }
    return t;
  }

  async send(credentials: SmtpCredentials, message: OutgoingMessage): Promise<SendResult> {
    try {
      const info = await this.transportFor(credentials).sendMail({
        from: { name: message.from.name ?? '', address: message.from.address },
        to: { name: message.to.name ?? '', address: message.to.address },
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: message.messageId,
        attachments: message.attachments,
      });
      // Pool and single-connection SentMessageInfo carry the same fields this helper reads.
      const preview = nodemailer.getTestMessageUrl(
        info as unknown as Parameters<typeof nodemailer.getTestMessageUrl>[0],
      );
      return {
        messageId: info.messageId,
        response: String(info.response ?? '').slice(0, 200),
        previewUrl: typeof preview === 'string' ? preview : null,
      };
    } catch (err) {
      throw classifySmtpError(err);
    }
  }

  async verify(credentials: SmtpCredentials): Promise<void> {
    const t = nodemailer.createTransport({
      host: credentials.host,
      port: credentials.port,
      secure: credentials.secure,
      auth: { user: credentials.user, pass: credentials.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    });
    try {
      await t.verify();
    } catch (err) {
      throw classifySmtpError(err);
    } finally {
      t.close();
    }
  }

  close(): void {
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
  }
}
