import { describe, expect, it } from 'vitest';
import {
  emailValidationError,
  isValidEmail,
  prepareRecipients,
} from '../../src/modules/emails/recipients.js';

describe('email validation', () => {
  it.each([
    'ada@example.com',
    'first.last+tag@sub.example.co.uk',
    "o'brien@example.ie",
    ' MiXeD@Example.COM ',
  ])('accepts %s', (email) => expect(isValidEmail(email)).toBe(true));

  it.each([
    ['', 'Empty address'],
    ['no-at-sign.com', 'Missing "@"'],
    ['.lead@example.com', 'Invalid dots in local part'],
    ['double..dot@example.com', 'Invalid dots in local part'],
    ['user@localhost', 'Invalid email address'],
    ['user@exa mple.com', 'Invalid email address'],
    ['user@example.123', 'Invalid top-level domain'],
    [`${'a'.repeat(65)}@example.com`, 'Local part is longer than 64 characters'],
  ])('rejects %j (%s)', (email, reason) => expect(emailValidationError(email)).toBe(reason));
});

describe('prepareRecipients', () => {
  it('normalises, de-duplicates case-insensitively and keeps first-seen order', () => {
    const r = prepareRecipients([
      { email: 'B@example.com', name: 'Bee' },
      { email: 'a@example.com' },
      { email: 'b@EXAMPLE.com', name: 'Duplicate' },
      { email: 'not-an-email' },
    ]);
    expect(r.accepted).toEqual([
      { email: 'b@example.com', name: 'Bee' },
      { email: 'a@example.com', name: null },
    ]);
    expect(r.duplicatesRemoved).toBe(1);
    expect(r.rejected).toEqual([{ input: 'not-an-email', reason: 'Missing "@"' }]);
  });

  it('strips header-injection characters from display names', () => {
    const r = prepareRecipients([{ email: 'x@example.com', name: 'Evil\r\nBcc: <a@b.c>' }]);
    expect(r.accepted[0]!.name).toBe('EvilBcc: a@b.c');
  });
});
