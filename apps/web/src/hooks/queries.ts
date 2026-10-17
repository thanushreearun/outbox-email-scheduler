import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken } from '../lib/api';
import type {
  AttachmentMeta,
  EmailCounts,
  EmailDetail,
  EmailListItem,
  EmailStatus,
  MeResponse,
  Paged,
  PublicConfig,
  ScheduleRequest,
  ScheduleResult,
  Sender,
  SlackStatus,
} from '../types/api';

export const qk = {
  me: ['me'] as const,
  config: ['config'] as const,
  senders: ['senders'] as const,
  counts: ['counts'] as const,
  emails: (view: string, params: object) => ['emails', view, params] as const,
  email: (id: string) => ['email', id] as const,
  slack: ['slack'] as const,
};

/** Returns null when signed out (401) instead of erroring. */
export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        const res = await api<{ data: MeResponse }>('/api/me');
        setCsrfToken(res.data.csrfToken);
        return res.data;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: qk.config,
    queryFn: async () => (await api<{ data: PublicConfig }>('/api/config')).data,
    staleTime: Infinity,
  });
}

export function useSenders() {
  return useQuery({
    queryKey: qk.senders,
    queryFn: async () => (await api<{ data: Sender[] }>('/api/senders')).data,
  });
}

export function useCounts() {
  return useQuery({
    queryKey: qk.counts,
    queryFn: async () => (await api<{ data: EmailCounts }>('/api/emails/counts')).data,
    refetchInterval: 15_000,
  });
}

export type MailView = 'scheduled' | 'sent';

export interface ListParams {
  page: number;
  pageSize: number;
  q: string;
  status: EmailStatus[];
}

export function useEmailList(view: MailView, params: ListParams) {
  const searching = params.q.trim().length > 0;
  return useQuery({
    queryKey: qk.emails(view, params),
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) });
      const statuses = params.status.length
        ? params.status
        : searching
          ? view === 'scheduled'
            ? (['SCHEDULED', 'PROCESSING', 'SENDING', 'RETRYING'] as EmailStatus[])
            : (['SENT', 'FAILED'] as EmailStatus[])
          : [];
      if (statuses.length) qs.set('status', statuses.join(','));
      if (searching) {
        qs.set('q', params.q.trim());
        return api<Paged<EmailListItem>>(`/api/emails/search?${qs}`, { signal });
      }
      return api<Paged<EmailListItem>>(`/api/emails/${view}?${qs}`, { signal });
    },
    placeholderData: keepPreviousData,
    refetchInterval: view === 'scheduled' ? 10_000 : 30_000,
  });
}

export function useEmail(id: string | undefined) {
  return useQuery({
    queryKey: qk.email(id ?? ''),
    queryFn: async () => (await api<{ data: EmailDetail }>(`/api/emails/${id}`)).data,
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && ['SENT', 'FAILED', 'CANCELLED'].includes(s) ? false : 5_000;
    },
  });
}

export function useSlackStatus() {
  return useQuery({
    queryKey: qk.slack,
    queryFn: async () => (await api<{ data: SlackStatus }>('/api/slack/status')).data,
  });
}

function useInvalidateMail() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['emails'] });
    void qc.invalidateQueries({ queryKey: qk.counts });
  };
}

export function useScheduleEmails() {
  const invalidate = useInvalidateMail();
  return useMutation({
    mutationFn: async (input: { body: ScheduleRequest; idempotencyKey: string }) =>
      (
        await api<{ data: ScheduleResult }>('/api/emails/batch', {
          method: 'POST',
          body: input.body,
          idempotencyKey: input.idempotencyKey,
        })
      ).data,
    onSuccess: invalidate,
  });
}

export function useCancelEmail() {
  const invalidate = useInvalidateMail();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api(`/api/emails/${id}/cancel`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: qk.email(id) });
    },
  });
}

export function useUploadAttachment() {
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return (await api<{ data: AttachmentMeta }>('/api/attachments', { method: 'POST', body: form })).data;
    },
  });
}

export function useDeleteAttachment() {
  return useMutation({
    mutationFn: async (id: string) => api(`/api/attachments/${id}`, { method: 'DELETE' }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => api('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      setCsrfToken(null);
      qc.setQueryData(qk.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'config' });
    },
  });
}
