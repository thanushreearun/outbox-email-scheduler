import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppRoutes } from '../app/App';

type Fixture = { status?: number; body?: unknown } | Record<string, unknown>;
type Handler = (init: RequestInit | undefined, url: URL) => Fixture | undefined;

/**
 * Stubs window.fetch with a route table: "METHOD /path" → handler. Unmatched requests
 * fail the test loudly so missing mocks are obvious.
 */
export function mockApi(routes: Record<string, Handler | Fixture>) {
  const calls: Array<{ method: string; path: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname + url.search, init });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`Unmocked request: ${method} ${url.pathname}`);
    const raw = typeof route === 'function' ? (route(init, url) ?? {}) : route;
    // A plain fixture like `{ data: ... }` is shorthand for `{ body: { data: ... } }`.
    const res: { status?: number; body?: unknown } = 'status' in raw || 'body' in raw ? raw : { body: raw };
    const status = res.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(res.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(path: string, ui: ReactElement = <AppRoutes />) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

export const me = {
  data: {
    user: { id: 'u1', email: 'oliver@example.com', name: 'Oliver Brown', avatarUrl: null },
    csrfToken: 'csrf-1',
    isAdmin: false,
  },
};

export const config = {
  data: {
    minDelayBetweenEmailsMs: 2000,
    maxEmailsPerHourPerSender: 100,
    maxEmailsPerHourGlobal: 200,
    maxRecipientsPerBatch: 5000,
    maxAttachmentBytes: 5 * 1024 * 1024,
    googleConfigured: true,
    slackConfigured: false,
    etherealConfigured: true,
  },
};

export const counts = { data: { scheduled: 0, sent: 0, failed: 0, cancelled: 0 } };
export const emptyPage = { data: [], meta: { page: 1, pageSize: 25, total: 0, totalPages: 1 } };
