/**
 * Recipient validation and de-duplication. Pure functions (unit tested).
 * The web app mirrors this logic for instant feedback, but the server is authoritative.
 */

// Practical address grammar (close to the WHATWG/HTML5 definition) plus RFC length limits.
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function emailValidationError(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (!email) return 'Empty address';
  if (email.length > 254) return 'Address is longer than 254 characters';
  const at = email.lastIndexOf('@');
  if (at < 1) return 'Missing "@"';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64) return 'Local part is longer than 64 characters';
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..'))
    return 'Invalid dots in local part';
  if (!EMAIL_RE.test(email)) return 'Invalid email address';
  if (!/[a-z]/i.test(domain.split('.').pop() ?? '')) return 'Invalid top-level domain';
  return null;
}

export const isValidEmail = (raw: string) => emailValidationError(raw) === null;

export interface RecipientInput {
  email: string;
  name?: string | null;
}

export interface PreparedRecipients {
  accepted: Array<{ email: string; name: string | null }>;
  rejected: Array<{ input: string; reason: string }>;
  duplicatesRemoved: number;
}

/** Validates, normalises (trim + lowercase) and de-duplicates while preserving input order. */
export function prepareRecipients(list: RecipientInput[]): PreparedRecipients {
  const seen = new Set<string>();
  const accepted: PreparedRecipients['accepted'] = [];
  const rejected: PreparedRecipients['rejected'] = [];
  let duplicatesRemoved = 0;
  for (const item of list) {
    const reason = emailValidationError(item.email);
    if (reason) {
      rejected.push({ input: item.email.slice(0, 320), reason });
      continue;
    }
    const email = normalizeEmail(item.email);
    if (seen.has(email)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(email);
    const name =
      item.name
        ?.trim()
        .replace(/[\r\n<>"]/g, '')
        .slice(0, 120) || null;
    accepted.push({ email, name });
  }
  return { accepted, rejected, duplicatesRemoved };
}
