import { afterEach, describe, expect, it } from 'vitest';
import { localInputToDate, MIN_LEAD_MS, scheduleTimeError, toLocalInput } from './SendLaterPopover';

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

describe('local date/time → UTC instant', () => {
  it.each([
    ['Asia/Kolkata', '2026-10-20T15:30', '2026-10-20T10:00:00.000Z'],
    ['UTC', '2026-10-20T15:30', '2026-10-20T15:30:00.000Z'],
    ['America/New_York', '2026-07-01T09:00', '2026-07-01T13:00:00.000Z'], // EDT, UTC-4
    ['America/New_York', '2026-12-01T09:00', '2026-12-01T14:00:00.000Z'], // EST, UTC-5
  ])('in %s, %s is %s', (tz, local, utc) => {
    process.env.TZ = tz;
    const date = localInputToDate(local);
    expect(date?.toISOString()).toBe(utc);
    expect(toLocalInput(date!)).toBe(local); // round-trips for display
  });

  it('returns null for empty or malformed input instead of guessing a time', () => {
    expect(localInputToDate('')).toBeNull();
    expect(localInputToDate('tomorrow')).toBeNull();
    expect(localInputToDate('2026-13-45T99:99')).toBeNull();
  });
});

describe('scheduleTimeError', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');

  it('requires a time', () => {
    expect(scheduleTimeError(null, now)).toBe('Pick a date and time');
    expect(scheduleTimeError(new Date('invalid'), now)).toBe('Pick a date and time');
  });

  it('rejects past and too-soon times', () => {
    expect(scheduleTimeError(new Date(now - 60_000), now)).toBe('Choose a time in the future');
    expect(scheduleTimeError(new Date(now + MIN_LEAD_MS - 1), now)).toBe('Choose a time in the future');
  });

  it('accepts a future time', () => {
    expect(scheduleTimeError(new Date(now + MIN_LEAD_MS), now)).toBeNull();
    expect(scheduleTimeError(new Date(now + 86_400_000), now)).toBeNull();
  });
});
