export type EmailStatus =
  'SCHEDULED' | 'PROCESSING' | 'SENDING' | 'RETRYING' | 'SENT' | 'FAILED' | 'CANCELLED';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface MeResponse {
  user: User;
  csrfToken: string;
  isAdmin: boolean;
}

export interface PublicConfig {
  minDelayBetweenEmailsMs: number;
  maxEmailsPerHourPerSender: number;
  maxEmailsPerHourGlobal: number;
  maxRecipientsPerBatch: number;
  maxAttachmentBytes: number;
  googleConfigured: boolean;
  slackConfigured: boolean;
  etherealConfigured: boolean;
}

export interface Sender {
  id: string;
  email: string;
  displayName: string | null;
  provider: 'ETHEREAL_ENV' | 'ETHEREAL' | 'SMTP';
  isActive: boolean;
  verifiedAt: string | null;
  createdAt: string;
}

export interface EmailListItem {
  id: string;
  batchId: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  snippet: string;
  status: EmailStatus;
  scheduledAt: string;
  deferredUntil: string | null;
  sentAt: string | null;
  attemptCount: number;
  lastError: string | null;
  lastErrorCode: string | null;
  attachmentCount: number;
  sender: { id: string; email: string; displayName: string | null };
  createdAt: string;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmailDetail extends EmailListItem {
  bodyHtml: string;
  previewUrl: string | null;
  providerMessageId: string | null;
  delayBetweenMs: number;
  hourlyLimit: number | null;
  attachments: AttachmentMeta[];
  events: Array<{ status: EmailStatus; message: string | null; createdAt: string }>;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  source?: 'elasticsearch' | 'database';
}

export interface Paged<T> {
  data: T[];
  meta: PageMeta;
}

export interface EmailCounts {
  scheduled: number;
  sent: number;
  failed: number;
  cancelled: number;
}

export interface ScheduleRequest {
  senderAccountId: string;
  recipients: Array<{ email: string; name?: string | null }>;
  subject: string;
  bodyHtml: string;
  startAt: string;
  delayBetweenMs?: number;
  hourlyLimit?: number | null;
  attachmentIds: string[];
}

export interface ScheduleResult {
  replayed: boolean;
  batchId: string;
  totalSubmitted: number;
  accepted: number;
  rejected: Array<{ input: string; reason: string }>;
  duplicatesRemoved: number;
  firstScheduledAt: string | null;
  lastScheduledAt: string | null;
  effectiveDelayMs: number;
  hourlyLimit: number | null;
  enqueue: { enqueued: number; pendingReconciliation: number };
}

export interface SlackStatus {
  configured: boolean;
  connected: boolean;
  connection: {
    status: 'ACTIVE' | 'REVOKED' | 'ERROR';
    teamName: string | null;
    channelName: string | null;
    configurationUrl: string | null;
    lastError: string | null;
    lastNotifiedAt: string | null;
    connectedAt: string;
  } | null;
}
