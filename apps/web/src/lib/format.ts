import { format, isSameDay, isSameWeek, isSameYear } from 'date-fns';

/** Compact badge time: "Tue 9:15:12 AM" within the week, otherwise "Nov 3, 9:15 AM". */
export function badgeTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (isSameDay(d, now)) return format(d, 'h:mm:ss a');
  if (isSameWeek(d, now)) return format(d, 'EEE h:mm:ss a');
  if (isSameYear(d, now)) return format(d, 'MMM d, h:mm a');
  return format(d, 'MMM d yyyy, h:mm a');
}

/** Detail header style: "Nov 3, 10:23 AM". */
export function detailTime(iso: string): string {
  const d = new Date(iso);
  return format(d, isSameYear(d, new Date()) ? 'MMM d, h:mm a' : 'MMM d yyyy, h:mm a');
}

export function fullTime(iso: string): string {
  return format(new Date(iso), "EEE, MMM d yyyy 'at' h:mm:ss a");
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timezoneLabel(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
