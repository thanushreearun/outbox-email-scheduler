import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCancelEmail, useEmailList, type MailView } from '../../hooks/queries';
import { describeError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fullTime } from '../../lib/format';
import type { EmailListItem, EmailStatus } from '../../types/api';
import { IconButton } from '../../components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '../../components/ui/States';
import { StatusBadge } from '../../components/ui/StatusBadge';

const FILTERS: Record<MailView, Array<{ label: string; value: EmailStatus[] }>> = {
  scheduled: [
    { label: 'All pending', value: [] },
    { label: 'Scheduled', value: ['SCHEDULED'] },
    { label: 'Sending', value: ['PROCESSING', 'SENDING'] },
    { label: 'Retrying', value: ['RETRYING'] },
    { label: 'Cancelled', value: ['CANCELLED'] },
  ],
  sent: [
    { label: 'All', value: [] },
    { label: 'Sent', value: ['SENT'] },
    { label: 'Failed', value: ['FAILED'] },
  ],
};

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function EmailRow({ email, view }: { email: EmailListItem; view: MailView }) {
  const cancel = useCancelEmail();
  const canCancel = email.status === 'SCHEDULED' || email.status === 'RETRYING';
  const when = view === 'sent' && email.sentAt ? email.sentAt : email.scheduledAt;
  return (
    <li className="group relative border-b border-line/80 last:border-b-0 hover:bg-[#FAFAFA]">
      <Link
        to={`/emails/${email.id}`}
        title={fullTime(when)}
        className="flex flex-col gap-1 px-4 py-3 focus-visible:bg-brand-50 focus-visible:outline-none sm:flex-row sm:items-center sm:gap-0 sm:py-[11px]"
      >
        <span className="w-[164px] shrink-0 truncate text-[13px] text-ink">
          To: {email.recipientName || email.recipientEmail}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <StatusBadge email={email} />
          <span className="min-w-0 truncate text-[13px]">
            <span className="font-medium text-ink">{email.subject}</span>
            <span className="text-ink-faint"> - {email.snippet}</span>
          </span>
          {email.attachmentCount > 0 && (
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-label="Has attachments" />
          )}
        </span>
        {email.status === 'FAILED' && email.lastError && (
          <span className="truncate text-2xs text-red-600 sm:ml-3 sm:max-w-[220px]" title={email.lastError}>
            {email.lastError}
          </span>
        )}
      </Link>
      {canCancel && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            label={`Cancel email to ${email.recipientEmail}`}
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(email.id, {
                onSuccess: () => toast.success('Scheduled email cancelled'),
                onError: (err) => toast.error(describeError(err)),
              })
            }
            className="bg-white"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </span>
      )}
    </li>
  );
}

export function MailboxPage({ view }: { view: MailView }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [filterIdx, setFilterIdx] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const q = useDebounced(query);
  const navigate = useNavigate();

  useEffect(() => {
    setPage(1);
  }, [q, filterIdx, view]);
  useEffect(() => {
    setFilterIdx(0);
    setQuery('');
  }, [view]);
  useEffect(() => {
    if (!filterOpen) return;
    const close = (e: MouseEvent) => !filterRef.current?.contains(e.target as Node) && setFilterOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [filterOpen]);

  const filter = FILTERS[view][filterIdx] ?? FILTERS[view][0]!;
  const list = useEmailList(view, { page, pageSize: 25, q, status: filter.value });
  const data = list.data;

  return (
    <main className="flex min-w-0 flex-1 flex-col px-3 pt-3 sm:px-6">
      <h1 className="sr-only">{view === 'scheduled' ? 'Scheduled emails' : 'Sent emails'}</h1>
      <div className="flex items-center gap-3">
        <label className="flex h-[30px] max-w-[480px] flex-1 items-center gap-2 rounded-full bg-surface-search px-3 focus-within:ring-2 focus-within:ring-brand-400">
          <Search className="h-4 w-4 text-ink-muted" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search emails"
            className="w-full bg-transparent text-[13px] placeholder:text-ink-muted focus:outline-none"
          />
        </label>
        <div ref={filterRef} className="relative">
          <IconButton
            label="Filter by status"
            aria-haspopup="listbox"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((v) => !v)}
          >
            <Filter className={cn('h-4 w-4', filterIdx > 0 && 'text-brand-600')} />
          </IconButton>
          {filterOpen && (
            <ul
              role="listbox"
              aria-label="Status filter"
              className="absolute right-0 z-20 mt-1 w-40 rounded-xl border border-line bg-white py-1 shadow-pop"
            >
              {FILTERS[view].map((f, i) => (
                <li key={f.label}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === filterIdx}
                    onClick={() => {
                      setFilterIdx(i);
                      setFilterOpen(false);
                    }}
                    className={cn(
                      'w-full px-3 py-1.5 text-left text-[13px] hover:bg-surface',
                      i === filterIdx && 'font-semibold text-brand-700',
                    )}
                  >
                    {f.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <IconButton label="Refresh" onClick={() => void list.refetch()}>
          <RefreshCw className={cn('h-4 w-4', list.isFetching && 'animate-spin')} />
        </IconButton>
      </div>

      {(q || filterIdx > 0) && data && (
        <p className="mt-3 text-2xs text-ink-muted">
          {data.meta.total} result{data.meta.total === 1 ? '' : 's'}
          {filterIdx > 0 && ` · ${filter.label}`}
          {data.meta.source === 'database' && ' · search index unavailable, showing database results'}
        </p>
      )}

      <section aria-live="polite" aria-busy={list.isFetching} className="mt-2">
        {list.isPending ? (
          <ul aria-label="Loading">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="flex items-center gap-4 border-b border-line px-4 py-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-20 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <ErrorState message={describeError(list.error)} onRetry={() => void list.refetch()} />
        ) : data && data.data.length === 0 ? (
          q || filterIdx > 0 ? (
            <EmptyState
              icon={<Search className="h-5 w-5" />}
              title="No matching emails"
              description="Try a different search term or filter."
            />
          ) : view === 'scheduled' ? (
            <EmptyState
              icon={<Clock className="h-5 w-5" />}
              title="Nothing scheduled"
              description="Emails you schedule appear here until they are sent."
              action={
                <button
                  type="button"
                  onClick={() => navigate('/compose')}
                  className="text-[13px] font-medium text-brand-600 hover:underline"
                >
                  Compose an email
                </button>
              }
            />
          ) : (
            <EmptyState
              icon={<Send className="h-5 w-5" />}
              title="No sent emails yet"
              description="Delivered and failed emails will show up here."
            />
          )
        ) : (
          <ul>
            {data?.data.map((e) => (
              <EmailRow key={e.id} email={e} view={view} />
            ))}
          </ul>
        )}
      </section>

      {data && data.meta.totalPages > 1 && (
        <nav
          aria-label="Pagination"
          className="flex items-center justify-end gap-2 py-3 text-2xs text-ink-muted"
        >
          <span>
            Page {data.meta.page} of {data.meta.totalPages}
          </span>
          <IconButton label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="Next page"
            disabled={page >= data.meta.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </nav>
      )}
    </main>
  );
}
