import { describe, expect, it } from 'vitest';
import { dedupeRecipients, isValidEmail, parseRecipientText } from './recipients';

describe('parseRecipientText', () => {
  it('reads a CSV with email and name columns', () => {
    const r = parseRecipientText(
      'Name,Email\nAda Lovelace,ada@example.com\nAlan,ALAN@example.com\n,not-an-email',
    );
    expect(r.valid).toEqual([
      { email: 'ada@example.com', name: 'Ada Lovelace' },
      { email: 'alan@example.com', name: 'Alan' },
    ]);
    expect(r.invalid).toEqual(['not-an-email']);
  });

  it('supports first/last name columns and semicolon delimiters', () => {
    const r = parseRecipientText('first name;last name;e-mail\nGrace;Hopper;grace@example.com');
    expect(r.valid).toEqual([{ email: 'grace@example.com', name: 'Grace Hopper' }]);
  });

  it('extracts addresses from free text and de-duplicates case-insensitively', () => {
    const r = parseRecipientText('a@example.com, b@example.com; A@EXAMPLE.com\n<c@example.com> junk');
    expect(r.valid.map((x) => x.email)).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual(['junk']);
  });

  it('counts a large headerless list', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `user${i}@example.com`).join('\n');
    expect(parseRecipientText(text).valid).toHaveLength(1000);
  });
});

describe('validation & dedupe', () => {
  it('rejects malformed addresses', () => {
    expect(isValidEmail('ok@example.com')).toBe(true);
    for (const bad of ['', 'x', 'a@b', 'a..b@example.com', '.a@example.com', 'a@example.123'])
      expect(isValidEmail(bad)).toBe(false);
  });
  it('skips addresses already present', () => {
    const r = dedupeRecipients(
      [{ email: 'a@example.com', name: null }],
      [{ email: 'A@example.com', name: null }],
    );
    expect(r.valid).toEqual([]);
    expect(r.duplicates).toBe(1);
  });
});
