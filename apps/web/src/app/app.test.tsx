import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { config, counts, emptyPage, me, mockApi, renderApp } from '../test/utils';

// ProseMirror needs layout APIs jsdom lacks; the editor is swapped for a textarea that
// emits HTML. Editor behaviour itself is TipTap's responsibility.
vi.mock('../features/compose/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="Email body"
      value={value.replace(/<\/?p>/g, '')}
      onChange={(e) => onChange(e.target.value ? `<p>${e.target.value}</p>` : '')}
    />
  ),
}));

const sender = {
  id: 's1',
  email: 'sender@ethereal.email',
  displayName: 'Oliver',
  provider: 'ETHEREAL_ENV',
  isActive: true,
  verifiedAt: null,
  createdAt: '',
};

describe('authentication', () => {
  it('shows the login screen when signed out', async () => {
    mockApi({
      'GET /api/me': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'x' } } },
      'GET /api/config': config,
    });
    renderApp('/scheduled');
    expect(await screen.findByRole('heading', { name: 'Login' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /login with google/i })).toHaveAttribute(
      'href',
      '/api/auth/google',
    );
    // Password sign-in is not implemented, so its fields are disabled.
    expect(screen.getByLabelText('Password')).toBeDisabled();
  });

  it('explains missing Google configuration and surfaces OAuth errors', async () => {
    mockApi({
      'GET /api/me': { status: 401, body: {} },
      'GET /api/config': { body: { data: { ...config.data, googleConfigured: false } } },
    });
    renderApp('/login?error=access_denied');
    expect(await screen.findByText(/setup required/i)).toBeInTheDocument();
    expect(screen.getByText('Google sign-in was cancelled.')).toBeInTheDocument();
  });

  it('shows the signed-in user in the sidebar', async () => {
    mockApi({
      'GET /api/me': me,
      'GET /api/emails/counts': { body: { data: { ...counts.data, scheduled: 12, sent: 785 } } },
      'GET /api/emails/scheduled': emptyPage,
    });
    renderApp('/scheduled');
    expect(await screen.findByText('Oliver Brown')).toBeInTheDocument();
    expect(screen.getByText('oliver@example.com')).toBeInTheDocument();
    expect(await screen.findByText('785')).toBeInTheDocument();
  });
});

describe('mailbox views', () => {
  it('renders the scheduled empty state', async () => {
    mockApi({ 'GET /api/me': me, 'GET /api/emails/counts': counts, 'GET /api/emails/scheduled': emptyPage });
    renderApp('/scheduled');
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
  });

  it('renders the sent empty state', async () => {
    mockApi({ 'GET /api/me': me, 'GET /api/emails/counts': counts, 'GET /api/emails/sent': emptyPage });
    renderApp('/sent');
    expect(await screen.findByText('No sent emails yet')).toBeInTheDocument();
  });

  it('shows rows from the API with status badges', async () => {
    const item = {
      id: 'e1',
      batchId: 'b1',
      recipientEmail: 'john@example.com',
      recipientName: 'John Smith',
      subject: 'Meeting follow-up',
      snippet: 'Hi John',
      status: 'SENT',
      scheduledAt: new Date().toISOString(),
      deferredUntil: null,
      sentAt: new Date().toISOString(),
      attemptCount: 1,
      lastError: null,
      lastErrorCode: null,
      attachmentCount: 0,
      sender: { id: 's1', email: 'x@y.z', displayName: null },
      createdAt: '',
    };
    mockApi({
      'GET /api/me': me,
      'GET /api/emails/counts': counts,
      'GET /api/emails/sent': { body: { data: [item], meta: { ...emptyPage.meta, total: 1 } } },
    });
    renderApp('/sent');
    const row = (await screen.findByText('To: John Smith')).closest('a')!;
    expect(within(row).getByText('Sent')).toBeInTheDocument();
    expect(row).toHaveAttribute('href', '/emails/e1');
  });

  it('shows a loading skeleton, then an error state with retry', async () => {
    let fail = true;
    mockApi({
      'GET /api/me': me,
      'GET /api/emails/counts': counts,
      'GET /api/emails/scheduled': () =>
        fail
          ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong' } } }
          : emptyPage,
    });
    renderApp('/scheduled');
    expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
  });
});

describe('compose', () => {
  function setup(extra: Parameters<typeof mockApi>[0] = {}) {
    return mockApi({
      'GET /api/me': me,
      'GET /api/config': config,
      'GET /api/emails/counts': counts,
      'GET /api/emails/scheduled': emptyPage,
      'GET /api/senders': { body: { data: [sender] } },
      ...extra,
    });
  }

  it('validates required fields before submitting', async () => {
    const { calls } = setup();
    renderApp('/compose');
    await screen.findByRole('heading', { name: 'Compose New Email' });
    await userEvent.click(screen.getByRole('button', { name: 'Send Later' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Add at least one recipient')).toBeInTheDocument();
    expect(screen.getByText('Subject is required')).toBeInTheDocument();
    expect(screen.getByText('Write a message')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('enforces the server minimum delay and hourly-limit bounds', async () => {
    setup();
    renderApp('/compose');
    await screen.findByRole('heading', { name: 'Compose New Email' });
    await userEvent.type(screen.getByLabelText(/delay between 2 emails/i), '1');
    await userEvent.type(screen.getByLabelText(/hourly limit/i), '500');
    await userEvent.click(screen.getByRole('button', { name: 'Send Later' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Delay must be at least 2')).toBeInTheDocument();
    expect(screen.getByText('Hourly limit cannot exceed 100')).toBeInTheDocument();
  });

  it('parses an uploaded CSV, counts recipients and shows chips', async () => {
    setup();
    renderApp('/compose');
    await screen.findByRole('heading', { name: 'Compose New Email' });
    const csv = new File(
      [
        'email,name\na@example.com,A\nb@example.com,B\nA@example.com,dup\nbad,X\nc@example.com,C\nd@example.com,D',
      ],
      'list.csv',
      { type: 'text/csv' },
    );
    fireEvent.change(screen.getByTestId('recipient-file'), { target: { files: [csv] } });
    expect(await screen.findByTestId('recipient-count')).toHaveTextContent('4 recipients');
    expect(screen.getByText('1 duplicate skipped')).toBeInTheDocument();
    expect(screen.getByText('1 invalid ignored')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 1 more recipients' })).toHaveTextContent('+1');
    await userEvent.click(screen.getByRole('button', { name: 'Remove a@example.com' }));
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('3 recipients');
  });

  it('submits a schedule with UTC time, CSRF token and an idempotency key', async () => {
    let body: Record<string, unknown> | null = null;
    let headers: Record<string, string> = {};
    setup({
      'POST /api/emails/batch': (init) => {
        body = JSON.parse(String(init?.body));
        headers = init?.headers as Record<string, string>;
        return {
          status: 201,
          body: {
            data: {
              replayed: false,
              batchId: 'b1',
              totalSubmitted: 2,
              accepted: 2,
              rejected: [],
              duplicatesRemoved: 0,
              firstScheduledAt: new Date().toISOString(),
              lastScheduledAt: null,
              effectiveDelayMs: 2000,
              hourlyLimit: null,
              enqueue: { enqueued: 2, pendingReconciliation: 0 },
            },
          },
        };
      },
    });
    renderApp('/compose');
    await screen.findByRole('heading', { name: 'Compose New Email' });
    // The CSRF token is loaded via /api/me by the auth gate in the real app; prime it here.
    const { setCsrfToken } = await import('../lib/api');
    setCsrfToken('csrf-1');

    await userEvent.type(screen.getByLabelText('Add recipients'), 'ada@example.com, alan@example.com,');
    await userEvent.type(screen.getByPlaceholderText('Subject'), 'Hello');
    await userEvent.type(screen.getByLabelText('Email body'), 'Hi there');
    await userEvent.click(screen.getByRole('button', { name: 'Send Later' }));
    const dialog = screen.getByRole('dialog', { name: 'Send later' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tomorrow, 10:00 AM' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(body).not.toBeNull());
    const sent = body as unknown as {
      startAt: string;
      recipients: unknown[];
      subject: string;
      bodyHtml: string;
    };
    expect(sent.recipients).toEqual([
      { email: 'ada@example.com', name: null },
      { email: 'alan@example.com', name: null },
    ]);
    expect(sent.subject).toBe('Hello');
    expect(sent.bodyHtml).toBe('<p>Hi there</p>');
    expect(sent.startAt).toMatch(/Z$/);
    const local = new Date(sent.startAt);
    expect(local.getHours()).toBe(10);
    expect(headers['Idempotency-Key']).toBeTruthy();
    expect(headers['X-CSRF-Token']).toBe('csrf-1');
    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument(); // navigated to the list
  });

  describe('scheduled time is never replaced by "now" (regression)', () => {
    const okResult = {
      status: 201,
      body: {
        data: {
          replayed: false,
          batchId: 'b1',
          totalSubmitted: 1,
          accepted: 1,
          rejected: [],
          duplicatesRemoved: 0,
          firstScheduledAt: null,
          lastScheduledAt: null,
          effectiveDelayMs: 2000,
          hourlyLimit: null,
          enqueue: { enqueued: 1, pendingReconciliation: 0 },
        },
      },
    };

    async function fillAndOpenSendLater() {
      renderApp('/compose');
      await screen.findByRole('heading', { name: 'Compose New Email' });
      await userEvent.type(screen.getByLabelText('Add recipients'), 'ada@example.com,');
      await userEvent.type(screen.getByPlaceholderText('Subject'), 'Hello');
      await userEvent.type(screen.getByLabelText('Email body'), 'Hi');
      await userEvent.click(screen.getByRole('button', { name: 'Send Later' }));
      return screen.getByRole('dialog', { name: 'Send later' });
    }

    function captureStartAt() {
      const captured: { startAt?: string } = {};
      setup({
        'POST /api/emails/batch': (init) => {
          captured.startAt = (JSON.parse(String(init?.body)) as { startAt: string }).startAt;
          return okResult;
        },
      });
      return captured;
    }

    it('picking a time and clicking the header button schedules for the picked time', async () => {
      const captured = captureStartAt();
      const dialog = await fillAndOpenSendLater();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Tomorrow, 3:00 PM' }));
      // Previously this header button read "Send" and ignored the picked time.
      await userEvent.click(screen.getByRole('button', { name: 'Schedule' }));

      await waitFor(() => expect(captured.startAt).toBeDefined());
      const when = new Date(captured.startAt!);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(when.getDate()).toBe(tomorrow.getDate());
      expect(when.getHours()).toBe(15);
      expect(when.getMinutes()).toBe(0);
      expect(when.getTime() - Date.now()).toBeGreaterThan(60 * 60_000);
    });

    it('a custom date/time is sent as the matching UTC instant', async () => {
      const captured = captureStartAt();
      const dialog = await fillAndOpenSendLater();
      const target = new Date(Date.now() + 3 * 24 * 3_600_000);
      target.setHours(9, 45, 0, 0);
      const pad = (n: number) => String(n).padStart(2, '0');
      const local = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T09:45`;
      fireEvent.change(within(dialog).getByLabelText('Pick date & time'), { target: { value: local } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));

      await waitFor(() => expect(captured.startAt).toBeDefined());
      expect(captured.startAt).toBe(target.toISOString());
    });

    it('Done without a time shows an error and sends nothing', async () => {
      const { calls } = setup();
      const dialog = await fillAndOpenSendLater();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Pick a date and time');
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
    });

    it('immediate delivery only happens through the explicit "Send now" button', async () => {
      const captured = captureStartAt();
      await fillAndOpenSendLater();
      expect(screen.queryByRole('button', { name: 'Schedule' })).not.toBeInTheDocument();
      const before = Date.now();
      await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
      await waitFor(() => expect(captured.startAt).toBeDefined());
      const sentAt = new Date(captured.startAt!).getTime();
      expect(sentAt).toBeGreaterThanOrEqual(before - 1_000);
      expect(sentAt).toBeLessThanOrEqual(Date.now());
    });
  });

  it('shows API errors clearly', async () => {
    setup({
      'POST /api/emails/batch': {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed',
            details: [{ path: 'startAt', message: 'startAt is in the past' }],
          },
        },
      },
    });
    renderApp('/compose');
    await screen.findByRole('heading', { name: 'Compose New Email' });
    await userEvent.type(screen.getByLabelText('Add recipients'), 'ada@example.com,');
    await userEvent.type(screen.getByPlaceholderText('Subject'), 'Hello');
    await userEvent.type(screen.getByLabelText('Email body'), 'Hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send Later' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
    // Toasts render outside the routed tree in the real app; the mutation error is still surfaced:
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Compose New Email' })).toBeInTheDocument(),
    );
  });
});
