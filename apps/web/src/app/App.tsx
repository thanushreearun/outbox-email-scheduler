import { lazy, Suspense } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { ApiError } from '../lib/api';
import { AppLayout } from '../components/layout/AppLayout';
import { LoginPage } from '../features/auth/LoginPage';
import { RequireAuth } from '../features/auth/RequireAuth';
import { FullPageSpinner } from '../components/ui/States';

// The rich-text editor is the heaviest dependency; load it only when composing.
const ComposePage = lazy(() =>
  import('../features/compose/ComposePage').then((m) => ({ default: m.ComposePage })),
);
import { EmailDetailPage } from '../features/detail/EmailDetailPage';
import { MailboxPage } from '../features/mail/MailboxPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { qk } from '../hooks/queries';

export function createQueryClient() {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: (count, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
      mutations: {
        // A 401 anywhere means the session ended: drop back to the login screen.
        onError: (err) => {
          if (err instanceof ApiError && err.status === 401) client.setQueryData(qk.me, null);
        },
      },
    },
  });
  return client;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to="/scheduled" replace />} />
          <Route path="/scheduled" element={<MailboxPage view="scheduled" />} />
          <Route path="/sent" element={<MailboxPage view="sent" />} />
          <Route
            path="/compose"
            element={
              <Suspense fallback={<FullPageSpinner />}>
                <ComposePage />
              </Suspense>
            }
          />
          <Route path="/emails/:id" element={<EmailDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App({ queryClient = createQueryClient() }: { queryClient?: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
      <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: 'text-[13px]' }} />
    </QueryClientProvider>
  );
}
