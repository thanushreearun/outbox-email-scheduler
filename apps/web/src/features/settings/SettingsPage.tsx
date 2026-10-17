import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Mail, Plus, Slack, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { qk, useConfig, useMe, useSenders, useSlackStatus } from '../../hooks/queries';
import { api, describeError } from '../../lib/api';
import { fullTime } from '../../lib/format';
import type { Sender } from '../../types/api';
import { Button } from '../../components/ui/Button';
import { ErrorState, Spinner } from '../../components/ui/States';

const SLACK_RESULTS: Record<string, ['success' | 'error', string]> = {
  connected: ['success', 'Slack connected. Rate-limit alerts will be posted to the selected channel.'],
  denied: ['error', 'Slack authorization was cancelled.'],
  expired: ['error', 'The Slack authorization link expired. Please try again.'],
  not_configured: ['error', 'Slack is not configured on the server.'],
  error: ['error', 'Slack connection failed. Please try again.'],
};

const PROVIDER_LABEL: Record<Sender['provider'], string> = {
  ETHEREAL_ENV: 'Ethereal (server default)',
  ETHEREAL: 'Ethereal mailbox',
  SMTP: 'SMTP',
};

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-line p-4 sm:p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function SendersCard() {
  const senders = useSenders();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.senders });
  const createEthereal = useMutation({
    mutationFn: () => api('/api/senders/ethereal', { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success('New Ethereal sender created');
      void refresh();
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const toggle = useMutation({
    mutationFn: (s: Sender) =>
      api(`/api/senders/${s.id}`, { method: 'PATCH', body: { isActive: !s.isActive } }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(describeError(e)),
  });

  return (
    <Card title="Sender accounts" icon={<Mail className="h-4 w-4 text-brand-600" />}>
      <p className="mb-4 text-2xs leading-5 text-ink-muted">
        A sender’s From address is always the mailbox its SMTP credentials authenticate as — arbitrary From
        addresses are not allowed. Ethereal captures every message instead of delivering it; open the preview
        link on a sent email to view it.
      </p>
      {senders.isPending ? (
        <Spinner />
      ) : senders.isError ? (
        <ErrorState message={describeError(senders.error)} onRetry={() => void senders.refetch()} />
      ) : senders.data.length === 0 ? (
        <p className="text-[13px] text-ink-muted">
          No senders yet. Configure ETHEREAL_USER/ETHEREAL_PASS on the server or create an Ethereal mailbox
          below.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {senders.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink">
                  {s.displayName ? `${s.displayName} <${s.email}>` : s.email}
                </p>
                <p className="text-2xs text-ink-muted">
                  {PROVIDER_LABEL[s.provider]} · {s.verifiedAt ? 'verified' : 'unverified'}
                </p>
              </div>
              <span className={`text-2xs font-medium ${s.isActive ? 'text-brand-600' : 'text-ink-muted'}`}>
                {s.isActive ? 'Active' : 'Disabled'}
              </span>
              <Button variant="ghost" size="sm" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                {s.isActive ? 'Disable' : 'Enable'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="outline"
        size="sm"
        className="mt-4"
        icon={<Plus className="h-4 w-4" />}
        loading={createEthereal.isPending}
        onClick={() => createEthereal.mutate()}
      >
        Create Ethereal test sender
      </Button>
    </Card>
  );
}

function SlackCard() {
  const status = useSlackStatus();
  const qc = useQueryClient();
  const disconnect = useMutation({
    mutationFn: () => api('/api/slack/connection', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Slack disconnected');
      void qc.invalidateQueries({ queryKey: qk.slack });
    },
    onError: (e) => toast.error(describeError(e)),
  });
  const test = useMutation({
    mutationFn: () => api('/api/slack/test', { method: 'POST' }),
    onSuccess: () => toast.success('Test message sent to Slack'),
    onError: (e) => {
      toast.error(describeError(e));
      void qc.invalidateQueries({ queryKey: qk.slack });
    },
  });

  const s = status.data;
  return (
    <Card title="Slack notifications" icon={<Slack className="h-4 w-4 text-brand-600" />}>
      <p className="mb-4 text-2xs leading-5 text-ink-muted">
        Get a Slack message when a sender reaches its hourly limit (once per sender per hour). Messages
        include the sender, limit and resume time — never recipients or content.
      </p>
      {status.isPending ? (
        <Spinner />
      ) : status.isError ? (
        <ErrorState message={describeError(status.error)} onRetry={() => void status.refetch()} />
      ) : !s?.configured ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-2xs text-amber-800">
          Slack isn’t configured on this server. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and
          SLACK_REDIRECT_URL (see README → “Slack OAuth setup”).
        </p>
      ) : s.connection ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-[13px]">
            {s.connected ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-brand-600" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 text-red-500" />
            )}
            <div>
              <p className="font-medium text-ink">
                {s.connected
                  ? 'Connected'
                  : s.connection.status === 'REVOKED'
                    ? 'Access revoked — reconnect'
                    : 'Connection error — reconnect'}{' '}
                to {s.connection.teamName ?? 'workspace'}
                {s.connection.channelName && (
                  <span className="text-ink-muted"> · {s.connection.channelName}</span>
                )}
              </p>
              <p className="text-2xs text-ink-muted">
                Connected {fullTime(s.connection.connectedAt)}
                {s.connection.lastNotifiedAt && ` · last message ${fullTime(s.connection.lastNotifiedAt)}`}
              </p>
              {s.connection.lastError && (
                <p className="mt-1 text-2xs text-red-600">{s.connection.lastError}</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {s.connected && (
              <Button variant="outline" size="sm" loading={test.isPending} onClick={() => test.mutate()}>
                Send test message
              </Button>
            )}
            <a
              href="/api/slack/oauth/start"
              className="inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-brand-600 hover:bg-brand-50"
            >
              {s.connected ? 'Change channel' : 'Reconnect Slack'}
            </a>
            {s.connection.configurationUrl && (
              <a
                href={s.connection.configurationUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-8 items-center gap-1 px-2 text-[13px] text-ink-muted hover:text-ink"
              >
                Manage in Slack <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <Button
              variant="danger"
              size="sm"
              loading={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <a
          href="/api/slack/oauth/start"
          className="inline-flex h-9 items-center gap-2 rounded-full bg-brand-500 px-4 text-sm font-medium text-white hover:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-1"
        >
          <Slack className="h-4 w-4" /> Connect Slack
        </a>
      )}
    </Card>
  );
}

function LimitsCard() {
  const cfg = useConfig().data;
  const me = useMe().data;
  if (!cfg) return null;
  return (
    <Card title="Sending limits" icon={<CheckCircle2 className="h-4 w-4 text-brand-600" />}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
        <div>
          <dt className="text-2xs text-ink-muted">Min delay between emails</dt>
          <dd className="font-medium">{cfg.minDelayBetweenEmailsMs / 1000}s</dd>
        </div>
        <div>
          <dt className="text-2xs text-ink-muted">Per sender / hour</dt>
          <dd className="font-medium">{cfg.maxEmailsPerHourPerSender}</dd>
        </div>
        <div>
          <dt className="text-2xs text-ink-muted">All senders / hour</dt>
          <dd className="font-medium">{cfg.maxEmailsPerHourGlobal}</dd>
        </div>
        <div>
          <dt className="text-2xs text-ink-muted">Recipients / batch</dt>
          <dd className="font-medium">{cfg.maxRecipientsPerBatch}</dd>
        </div>
      </dl>
      {me?.isAdmin && (
        <a
          href="/admin/queues"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-brand-600 hover:underline"
        >
          Open live queue dashboard <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </Card>
  );
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  useEffect(() => {
    const result = params.get('slack');
    if (!result) return;
    const [kind, msg] = SLACK_RESULTS[result] ?? SLACK_RESULTS.error!;
    if (kind === 'success') toast.success(msg);
    else toast.error(msg);
    void qc.invalidateQueries({ queryKey: qk.slack });
    setParams({}, { replace: true });
  }, [params, setParams, qc]);

  return (
    <main className="flex-1 px-4 py-6 sm:px-8">
      <h1 className="mb-6 text-[19px] font-medium text-ink">Settings</h1>
      <div className="grid max-w-[760px] grid-cols-[minmax(0,1fr)] gap-5">
        <SendersCard />
        <SlackCard />
        <LimitsCard />
      </div>
    </main>
  );
}
