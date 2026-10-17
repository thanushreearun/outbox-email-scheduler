import { AlertTriangle, Clock, Hourglass, Loader2, RotateCw, XCircle } from 'lucide-react';
import { badgeTime } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { EmailListItem } from '../../types/api';

const base =
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-[2px] text-2xs font-medium';

/** Status pill: orange clock for scheduled, grey for sent, red for failed. */
export function StatusBadge({
  email,
}: {
  email: Pick<EmailListItem, 'status' | 'scheduledAt' | 'deferredUntil' | 'sentAt' | 'attemptCount'>;
}) {
  switch (email.status) {
    case 'SCHEDULED':
      if (email.deferredUntil && new Date(email.deferredUntil) > new Date(email.scheduledAt)) {
        return (
          <span
            className={cn(base, 'border-amber-200 bg-amber-50 text-amber-700')}
            title="Hourly limit reached — deferred"
          >
            <Hourglass className="h-3 w-3" aria-hidden />
            {badgeTime(email.deferredUntil)}
          </span>
        );
      }
      return (
        <span className={cn(base, 'border-[#F9D3B4] bg-[#FFF2E8] text-[#C2410C]')}>
          <Clock className="h-3 w-3" aria-hidden />
          {badgeTime(email.scheduledAt)}
        </span>
      );
    case 'PROCESSING':
    case 'SENDING':
      return (
        <span className={cn(base, 'border-sky-200 bg-sky-50 text-sky-700')}>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Sending
        </span>
      );
    case 'RETRYING':
      return (
        <span className={cn(base, 'border-amber-200 bg-amber-50 text-amber-700')}>
          <RotateCw className="h-3 w-3" aria-hidden />
          Retrying ({email.attemptCount})
        </span>
      );
    case 'SENT':
      return <span className={cn(base, 'border-transparent bg-[#F1F1F1] text-ink-soft')}>Sent</span>;
    case 'FAILED':
      return (
        <span className={cn(base, 'border-red-200 bg-red-50 text-red-600')}>
          <AlertTriangle className="h-3 w-3" aria-hidden />
          Failed
        </span>
      );
    case 'CANCELLED':
      return (
        <span className={cn(base, 'border-transparent bg-[#F1F1F1] text-ink-muted')}>
          <XCircle className="h-3 w-3" aria-hidden />
          Cancelled
        </span>
      );
  }
}
