import Papa from 'papaparse';

/**
 * Client-side recipient parsing for instant feedback. Mirrors the server's validation
 * (apps/api/src/modules/emails/recipients.ts), which remains authoritative.
 */
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  if (!email || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const local = email.slice(0, at);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!EMAIL_RE.test(email)) return false;
  return /[a-z]/i.test(email.split('.').pop() ?? '');
}

export interface Recipient {
  email: string;
  name: string | null;
}

export interface ParsedRecipients {
  valid: Recipient[];
  invalid: string[];
  duplicates: number;
}

const EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'mail', 'recipient'];
const NAME_HEADERS = ['name', 'full name', 'fullname', 'display name'];

/**
 * Accepts CSV (with or without a header row) or free text separated by commas,
 * semicolons, whitespace or new lines. With a header, an "email" column and optional
 * "name" column are used; otherwise every cell is scanned for addresses.
 */
export function parseRecipientText(text: string, maxRows = 100_000): ParsedRecipients {
  const rows = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: 'greedy',
    delimitersToGuess: [',', ';', '\t', '|'],
  }).data.slice(0, maxRows + 1);
  const candidates: Recipient[] = [];

  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const emailCol = header.findIndex((h) => EMAIL_HEADERS.includes(h));
  if (emailCol >= 0) {
    const nameCol = header.findIndex((h) => NAME_HEADERS.includes(h));
    const first = header.indexOf('first name');
    const last = header.indexOf('last name');
    for (const row of rows.slice(1)) {
      const email = row[emailCol]?.trim() ?? '';
      if (!email) continue;
      const name =
        (nameCol >= 0
          ? row[nameCol]
          : [first >= 0 ? row[first] : '', last >= 0 ? row[last] : ''].join(' ')
        )?.trim() || null;
      candidates.push({ email, name });
    }
  } else {
    for (const row of rows) {
      for (const cell of row) {
        for (const token of cell.split(/[\s,;]+/)) {
          const cleaned = token.replace(/^[<"'(]+|[>"')]+$/g, '').trim();
          if (cleaned) candidates.push({ email: cleaned, name: null });
        }
      }
    }
  }
  return dedupeRecipients(candidates);
}

export function dedupeRecipients(list: Recipient[], existing: Recipient[] = []): ParsedRecipients {
  const seen = new Set(existing.map((r) => normalizeEmail(r.email)));
  const valid: Recipient[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const r of list) {
    if (!isValidEmail(r.email)) {
      invalid.push(r.email);
      continue;
    }
    const email = normalizeEmail(r.email);
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    valid.push({ email, name: r.name });
  }
  return { valid, invalid, duplicates };
}
