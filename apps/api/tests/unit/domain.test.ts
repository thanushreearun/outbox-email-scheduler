import { describe, expect, it } from 'vitest';
import { classifySmtpError } from '../../src/integrations/mailer.js';
import { decryptSecret, encryptSecret } from '../../src/lib/crypto.js';
import { windowStart } from '../../src/lib/time.js';
import { idempotencyKeySchema, scheduleBatchSchema } from '../../src/modules/emails/email.schemas.js';
import { htmlToText, sanitizeEmailHtml } from '../../src/modules/emails/sanitize.js';
import { canTransition, isTerminal, TRANSITIONS } from '../../src/modules/emails/status.js';
import { verifySlackSignature } from '../../src/modules/slack/slack.client.js';
import { createHmac } from 'node:crypto';

describe('status lifecycle', () => {
  it('terminal states have no outgoing transitions', () => {
    for (const s of ['SENT', 'FAILED', 'CANCELLED'] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(TRANSITIONS[s]).toHaveLength(0);
    }
  });
  it('allows the happy path and rate-limit deferral', () => {
    expect(canTransition('SCHEDULED', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'SENDING')).toBe(true);
    expect(canTransition('SENDING', 'SENT')).toBe(true);
    expect(canTransition('PROCESSING', 'SCHEDULED')).toBe(true);
  });
  it('never re-enters SENDING from SENDING or cancels in-flight work', () => {
    expect(canTransition('SENDING', 'SENDING')).toBe(false);
    expect(canTransition('SENDING', 'CANCELLED')).toBe(false);
    expect(canTransition('PROCESSING', 'CANCELLED')).toBe(false);
    expect(canTransition('SENT', 'SCHEDULED')).toBe(false);
  });
});

describe('rate-limit windows (UTC, epoch-aligned)', () => {
  const HOUR = 3_600_000;
  it('treats 1h windows as UTC clock hours', () => {
    const t = Date.parse('2026-03-01T14:59:59.999Z');
    expect(new Date(windowStart(Math.floor(t / HOUR), HOUR)).toISOString()).toBe('2026-03-01T14:00:00.000Z');
    const next = Math.floor(Date.parse('2026-03-01T15:00:00.000Z') / HOUR);
    expect(next).toBe(Math.floor(t / HOUR) + 1);
  });
});

describe('schedule request validation', () => {
  const base = {
    senderAccountId: '6c1f8f6e-3b5a-4c55-9a51-1d1b0f6f1a10',
    recipients: [{ email: 'a@example.com' }],
    subject: 'Hi',
    bodyHtml: '<p>x</p>',
  };
  it('requires a timezone-qualified startAt', () => {
    expect(scheduleBatchSchema.safeParse({ ...base, startAt: '2030-01-01T09:00:00' }).success).toBe(false);
    expect(scheduleBatchSchema.safeParse({ ...base, startAt: '' }).success).toBe(false);
    expect(scheduleBatchSchema.safeParse({ ...base }).success).toBe(false);
  });
  it('rejects past times beyond the grace window and accepts near-now', () => {
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(scheduleBatchSchema.safeParse({ ...base, startAt: past }).success).toBe(false);
    const now = new Date(Date.now() - 5_000).toISOString();
    expect(scheduleBatchSchema.safeParse({ ...base, startAt: now }).success).toBe(true);
  });
  it('rejects schedules more than a year ahead', () => {
    const far = new Date(Date.now() + 400 * 24 * 3_600_000).toISOString();
    expect(scheduleBatchSchema.safeParse({ ...base, startAt: far }).success).toBe(false);
  });
  it('validates Idempotency-Key format', () => {
    expect(idempotencyKeySchema.safeParse('3f1c1f8e-7d0a-4b19-9f0e-0b6d6e0f3c11').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has spaces in it!!').success).toBe(false);
    expect(idempotencyKeySchema.safeParse(undefined).success).toBe(false);
  });
});

describe('HTML sanitisation', () => {
  it('removes scripts, handlers and dangerous URLs but keeps formatting', () => {
    const out = sanitizeEmailHtml(
      '<p style="text-align:center;color:red" onclick="x()">Hi <strong>there</strong><script>alert(1)</script></p><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><iframe src="x"></iframe>',
    );
    expect(out).toContain('<strong>there</strong>');
    expect(out).toContain('style="text-align:center"');
    expect(out).not.toMatch(/script|onclick|javascript:|iframe|color:red/);
    expect(out).toContain('rel="noopener noreferrer"');
  });
  it('produces a readable text alternative', () => {
    expect(htmlToText('<p>Hello &amp; welcome</p><ul><li>One</li><li>Two</li></ul>')).toBe(
      'Hello & welcome\n• One\n• Two',
    );
  });
});

describe('secret encryption', () => {
  it('round-trips and detects tampering', () => {
    const c = encryptSecret('xoxb-secret');
    expect(c).not.toContain('xoxb');
    expect(decryptSecret(c)).toBe('xoxb-secret');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});

describe('SMTP error classification', () => {
  it('treats 4xx and network errors as transient, 5xx/auth/envelope as permanent', () => {
    expect(classifySmtpError({ responseCode: 421, message: 'busy' }).kind).toBe('transient');
    expect(classifySmtpError({ code: 'ETIMEDOUT', message: 't' }).kind).toBe('transient');
    expect(classifySmtpError({ responseCode: 550, message: 'no such user' }).kind).toBe('permanent');
    expect(classifySmtpError({ code: 'EAUTH', message: 'bad creds' }).code).toBe('SMTP_AUTH');
    expect(classifySmtpError({ code: 'EENVELOPE', message: 'x' }).kind).toBe('permanent');
  });
});

describe('Slack request signature', () => {
  const secret = 'signing-secret';
  const body = '{"type":"url_verification"}';
  const ts = '1700000000';
  const sig = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  it('accepts a valid, fresh signature', () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sig,
        rawBody: body,
        nowSeconds: 1700000100,
      }),
    ).toBe(true);
  });
  it('rejects stale timestamps and modified bodies', () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sig,
        rawBody: body,
        nowSeconds: 1700000400,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sig,
        rawBody: `${body} `,
        nowSeconds: 1700000100,
      }),
    ).toBe(false);
  });
});
