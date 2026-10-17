import { useEffect, useMemo, useRef } from 'react';
import { addDays, format, isValid, parse, setHours, setMinutes, setSeconds, startOfMinute } from 'date-fns';
import { CalendarDays } from 'lucide-react';
import { cn } from '../../lib/cn';
import { timezoneLabel } from '../../lib/format';
import { Button } from '../../components/ui/Button';

/** A scheduled time must be at least this far ahead, so "later" can never mean "now". */
export const MIN_LEAD_MS = 30_000;

const LOCAL_INPUT_FORMAT = "yyyy-MM-dd'T'HH:mm";

export function quickOptions(now = new Date()) {
  const tomorrow = addDays(now, 1);
  const at = (h: number) => setSeconds(setMinutes(setHours(tomorrow, h), 0), 0);
  return [
    { label: 'Tomorrow', date: startOfMinute(tomorrow) },
    { label: 'Tomorrow, 10:00 AM', date: at(10) },
    { label: 'Tomorrow, 11:00 AM', date: at(11) },
    { label: 'Tomorrow, 3:00 PM', date: at(15) },
  ];
}

/** Formats a Date as a `datetime-local` value in the browser's timezone. */
export const toLocalInput = (d: Date) => format(d, LOCAL_INPUT_FORMAT);

/**
 * Parses a `datetime-local` value ("2026-10-20T15:30") as wall-clock time in the
 * browser's timezone. Returns null for empty or malformed input.
 */
export function localInputToDate(value: string): Date | null {
  if (!value) return null;
  const date = parse(value, LOCAL_INPUT_FORMAT, new Date());
  return isValid(date) ? date : null;
}

/** Returns a user-facing error, or null when `when` is a valid future schedule. */
export function scheduleTimeError(when: Date | null, now = Date.now()): string | null {
  if (!when || Number.isNaN(when.getTime())) return 'Pick a date and time';
  if (when.getTime() < now + MIN_LEAD_MS) return 'Choose a time in the future';
  return null;
}

export interface SendLaterPopoverProps {
  selected: Date | null;
  onSelect: (when: Date | null) => void;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}

/**
 * Date/time picker for scheduled sends. The selection is owned by the compose page, so
 * every "send" control there uses the same chosen time.
 */
export function SendLaterPopover({
  selected,
  onSelect,
  error,
  onCancel,
  onConfirm,
  busy,
}: SendLaterPopoverProps) {
  const options = useMemo(() => quickOptions(), []);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Send later"
      className="absolute right-0 top-full z-30 mt-1 w-[228px] rounded-lg border border-line bg-white px-3 pb-3 pt-4 shadow-pop"
    >
      <h2 className="text-[13px] font-medium text-ink">Send Later</h2>
      <label className="mt-3 flex items-center gap-2 border-b border-line pb-1.5 text-2xs text-ink-muted">
        <span className="sr-only">Pick date &amp; time</span>
        <input
          type="datetime-local"
          aria-label="Pick date & time"
          min={toLocalInput(new Date())}
          value={selected ? toLocalInput(selected) : ''}
          onChange={(e) => onSelect(localInputToDate(e.target.value))}
          className="w-full bg-transparent text-2xs text-ink focus:outline-none [&::-webkit-calendar-picker-indicator]:opacity-0"
        />
        <CalendarDays className="pointer-events-none h-3.5 w-3.5 shrink-0" aria-hidden />
      </label>
      <ul className="mt-2 space-y-0.5">
        {options.map((o) => {
          const active = selected?.getTime() === o.date.getTime();
          return (
            <li key={o.label}>
              <button
                type="button"
                onClick={() => onSelect(o.date)}
                aria-pressed={active}
                title={format(o.date, 'EEE, MMM d h:mm a')}
                className={cn(
                  'w-full rounded px-0 py-1.5 text-left text-2xs text-ink hover:text-brand-700',
                  active && 'font-semibold text-brand-700',
                )}
              >
                {o.label}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-[10px] text-ink-faint">Times are in {timezoneLabel()}</p>
      {error && (
        <p role="alert" className="mt-1 text-2xs text-red-600">
          {error}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-4">
        <button type="button" onClick={onCancel} className="text-2xs font-medium text-ink hover:underline">
          Cancel
        </button>
        <Button variant="outline" size="sm" onClick={onConfirm} loading={busy} className="h-7 w-[60px]">
          Done
        </Button>
      </div>
    </div>
  );
}
