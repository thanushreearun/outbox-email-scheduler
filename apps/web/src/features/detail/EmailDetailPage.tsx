import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, FileText, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCancelEmail, useEmail, useMe } from '../../hooks/queries';
import { describeError } from '../../lib/api';
import { detailTime, fileSize, fullTime } from '../../lib/format';
import { safeEmailHtml } from '../../lib/sanitize';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/Button';
import { ErrorState, Spinner } from '../../components/ui/States';
import { StatusBadge } from '../../components/ui/StatusBadge';

export function EmailDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe().data;
  const email = useEmail(id);
  const cancel = useCancelEmail();

  if (email.isPending) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <Spinner />
      </main>
    );
  }
  if (email.isError) {
    return (
      <main className="flex-1">
        <ErrorState message={describeError(email.error)} onRetry={() => void email.refetch()} />
      </main>
    );
  }
  const e = email.data;
  const senderName = e.sender.displayName ?? e.sender.email;
  const canCancel = e.status === 'SCHEDULED' || e.status === 'RETRYING';
  const timestamp = e.sentAt ?? e.scheduledAt;

  return (
    <main className="flex min-w-0 flex-1 flex-col pb-12">
      <header className="flex items-center gap-3 px-3 py-3 sm:px-[10px]">
        <IconButton label="Back" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-5 w-5 text-ink" />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate text-[19px] font-medium text-ink">{e.subject}</h1>
        <div className="flex items-center gap-1">
          {canCancel && (
            <IconButton
              label="Cancel scheduled send"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(e.id, {
                  onSuccess: () => toast.success('Scheduled email cancelled'),
                  onError: (err) => toast.error(describeError(err)),
                })
              }
            >
              <Trash2 className="h-[18px] w-[18px]" />
            </IconButton>
          )}
          <span className="mx-2 h-6 w-px bg-line" aria-hidden />
          {me && <Avatar name={me.user.name} src={me.user.avatarUrl} size={28} />}
        </div>
      </header>

      <article className="mx-auto w-full max-w-[744px] px-4 pt-4 sm:px-0">
        <div className="flex items-start gap-3">
          <Avatar name={senderName} size={32} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-[13px] font-semibold text-ink">{senderName}</span>
              <span className="text-2xs text-ink-muted">&lt;{e.sender.email}&gt;</span>
            </div>
            <p className="text-2xs text-ink-muted">
              to {e.recipientName ? `${e.recipientName} <${e.recipientEmail}>` : e.recipientEmail}
            </p>
          </div>
          <time dateTime={timestamp} title={fullTime(timestamp)} className="shrink-0 text-2xs text-ink-muted">
            {detailTime(timestamp)}
          </time>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
          <StatusBadge email={e} />
          {e.status === 'SCHEDULED' && (
            <span>Scheduled for {fullTime(e.deferredUntil ?? e.scheduledAt)}</span>
          )}
          {e.deferredUntil && <span>· deferred by hourly limit (originally {fullTime(e.scheduledAt)})</span>}
          {e.sentAt && <span>Sent {fullTime(e.sentAt)}</span>}
          {e.attemptCount > 1 && <span>· {e.attemptCount} attempts</span>}
          {e.previewUrl && (
            <a
              href={e.previewUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline"
            >
              Ethereal preview <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
        </div>
        {e.lastError && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-2xs text-red-700">
            {e.lastErrorCode ? <strong>{e.lastErrorCode}: </strong> : null}
            {e.lastError}
          </p>
        )}

        <div
          className="email-prose mt-6 text-[13px] leading-6 text-ink"
          dangerouslySetInnerHTML={{ __html: safeEmailHtml(e.bodyHtml) }}
        />

        {e.attachments.length > 0 && (
          <ul className="mt-6 flex flex-wrap gap-3" aria-label="Attachments">
            {e.attachments.map((a) => {
              const href = `/api/attachments/${a.id}/content`;
              return (
                <li key={a.id}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="block w-[150px] overflow-hidden rounded-lg border border-line bg-surface hover:border-brand-200"
                  >
                    {a.mimeType.startsWith('image/') ? (
                      <img
                        src={href}
                        alt={a.filename}
                        className="h-[84px] w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-[84px] items-center justify-center">
                        <FileText className="h-6 w-6 text-ink-muted" aria-hidden />
                      </div>
                    )}
                    <div className="bg-[#F7F7F7] px-2 py-1.5">
                      <p className="truncate text-2xs text-ink">{a.filename}</p>
                      <p className="text-[10px] text-ink-muted">{fileSize(a.sizeBytes)}</p>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}

        <details className="mt-8 text-2xs text-ink-muted">
          <summary className="cursor-pointer select-none hover:text-ink">Delivery timeline</summary>
          <ol className="mt-2 space-y-1 border-l border-line pl-3">
            {e.events.map((ev, i) => (
              <li key={i}>
                <span className="font-medium text-ink-soft">{ev.status}</span> · {fullTime(ev.createdAt)}
                {ev.message && <span className="text-ink-faint"> — {ev.message}</span>}
              </li>
            ))}
          </ol>
          <p className="mt-2">
            Delay between emails: {Math.round(e.delayBetweenMs / 1000)}s · Hourly limit:{' '}
            {e.hourlyLimit ?? 'sender default'}
          </p>
        </details>
      </article>
    </main>
  );
}
