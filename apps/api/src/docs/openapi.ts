/**
 * OpenAPI 3.1 description of the public API, served at /api/openapi.json and rendered at /api/docs.
 * Kept by hand next to the routes; the Zod schemas in each module are the runtime source of truth.
 */
const errorSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', example: 'VALIDATION_FAILED' },
        message: { type: 'string' },
        details: {},
        requestId: { type: 'string' },
      },
    },
  },
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, example?: unknown) => ({
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const errors = {
  '400': { description: 'Validation failed', ...json(ref('Error')) },
  '401': { description: 'Not authenticated', ...json(ref('Error')) },
  '403': { description: 'CSRF/permission failure', ...json(ref('Error')) },
};
const csrf = [
  {
    in: 'header',
    name: 'X-CSRF-Token',
    required: true,
    schema: { type: 'string' },
    description: 'Value of `csrfToken` from GET /api/me',
  },
];
const page = [
  { in: 'query', name: 'page', schema: { type: 'integer', minimum: 1, default: 1 } },
  { in: 'query', name: 'pageSize', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
  { in: 'query', name: 'status', schema: { type: 'string' }, description: 'Comma-separated status filter' },
];

const scheduleExample = {
  senderAccountId: '6c1f8f6e-3b5a-4c55-9a51-1d1b0f6f1a10',
  recipients: [{ email: 'ada@example.com', name: 'Ada Lovelace' }, { email: 'alan@example.com' }],
  subject: 'Quarterly update',
  bodyHtml: '<p>Hello there!</p>',
  startAt: '2026-11-01T09:00:00.000Z',
  delayBetweenMs: 2000,
  hourlyLimit: 50,
  attachmentIds: [],
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Outbox Email Scheduler API',
    version: '1.0.0',
    description:
      'Cookie-session API (HttpOnly `outbox_sid`). State-changing requests require `X-CSRF-Token`. ' +
      'All responses use `{ data, meta? }` on success and `{ error: { code, message, details?, requestId } }` on failure.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'outbox_sid' } },
    schemas: {
      Error: errorSchema,
      EmailStatus: {
        type: 'string',
        enum: ['SCHEDULED', 'PROCESSING', 'SENDING', 'RETRYING', 'SENT', 'FAILED', 'CANCELLED'],
      },
      EmailListItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          batchId: { type: 'string', format: 'uuid' },
          recipientEmail: { type: 'string' },
          recipientName: { type: ['string', 'null'] },
          subject: { type: 'string' },
          snippet: { type: 'string' },
          status: ref('EmailStatus'),
          scheduledAt: { type: 'string', format: 'date-time' },
          deferredUntil: { type: ['string', 'null'], format: 'date-time' },
          sentAt: { type: ['string', 'null'], format: 'date-time' },
          attemptCount: { type: 'integer' },
          lastError: { type: ['string', 'null'] },
          lastErrorCode: { type: ['string', 'null'] },
          attachmentCount: { type: 'integer' },
          sender: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              displayName: { type: ['string', 'null'] },
            },
          },
        },
      },
      PageMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
      ScheduleBatchRequest: {
        type: 'object',
        required: ['senderAccountId', 'recipients', 'subject', 'bodyHtml', 'startAt'],
        properties: {
          senderAccountId: { type: 'string', format: 'uuid' },
          recipients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string' }, name: { type: 'string' } },
            },
          },
          subject: { type: 'string', maxLength: 250 },
          bodyHtml: { type: 'string', description: 'Sanitised server-side with a strict allow-list' },
          startAt: {
            type: 'string',
            format: 'date-time',
            description: 'UTC instant. Send-now = current time. Up to 2 minutes in the past is accepted.',
          },
          delayBetweenMs: {
            type: 'integer',
            description: 'Minimum spacing between sends; cannot be below MIN_DELAY_BETWEEN_EMAILS_MS',
          },
          hourlyLimit: {
            type: ['integer', 'null'],
            description: 'Optional per-batch cap; cannot exceed MAX_EMAILS_PER_HOUR_PER_SENDER',
          },
          attachmentIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 5 },
        },
      },
      ScheduleResult: {
        type: 'object',
        properties: {
          replayed: { type: 'boolean' },
          batchId: { type: 'string' },
          totalSubmitted: { type: 'integer' },
          accepted: { type: 'integer' },
          rejected: {
            type: 'array',
            items: { type: 'object', properties: { input: { type: 'string' }, reason: { type: 'string' } } },
          },
          duplicatesRemoved: { type: 'integer' },
          firstScheduledAt: { type: 'string', format: 'date-time' },
          lastScheduledAt: { type: 'string', format: 'date-time' },
          effectiveDelayMs: { type: 'integer' },
          hourlyLimit: { type: ['integer', 'null'] },
          enqueue: {
            type: 'object',
            properties: { enqueued: { type: 'integer' }, pendingReconciliation: { type: 'integer' } },
          },
        },
      },
    },
  },
  security: [{ session: [] }],
  paths: {
    '/api/health': {
      get: {
        tags: ['health'],
        security: [],
        summary: 'Liveness',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/health/ready': {
      get: {
        tags: ['health'],
        security: [],
        summary: 'Readiness (Postgres, Redis required; Elasticsearch reported)',
        responses: { '200': { description: 'Ready' }, '503': { description: 'Degraded' } },
      },
    },
    '/api/config': {
      get: {
        tags: ['meta'],
        security: [],
        summary: 'Public limits and integration flags',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/auth/google': {
      get: {
        tags: ['auth'],
        security: [],
        summary: 'Start Google sign-in (302 to Google)',
        responses: { '302': { description: 'Redirect' } },
      },
    },
    '/api/auth/google/callback': {
      get: {
        tags: ['auth'],
        security: [],
        summary: 'OAuth callback; sets session cookie and redirects to the app',
        responses: { '303': { description: 'Redirect' } },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['auth'],
        parameters: csrf,
        summary: 'Invalidate the session',
        responses: { '204': { description: 'Logged out' } },
      },
    },
    '/api/me': {
      get: {
        tags: ['auth'],
        summary: 'Current user and CSRF token',
        responses: {
          '200': json(
            { type: 'object' },
            {
              data: {
                user: { id: '…', email: 'oliver@example.com', name: 'Oliver Brown', avatarUrl: null },
                csrfToken: '…',
                isAdmin: false,
              },
            },
          ),
          '401': errors['401'],
        },
      },
    },
    '/api/senders': {
      get: {
        tags: ['senders'],
        summary: 'List sender accounts (no secrets)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/senders/ethereal': {
      post: {
        tags: ['senders'],
        parameters: csrf,
        summary: 'Deliberately create a new Ethereal mailbox as a sender',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/api/senders/smtp': {
      post: {
        tags: ['senders'],
        parameters: csrf,
        summary: 'Add an SMTP sender (verified by SMTP handshake)',
        responses: { '201': { description: 'Created' }, '422': { description: 'SMTP verification failed' } },
      },
    },
    '/api/senders/{id}': {
      patch: {
        tags: ['senders'],
        parameters: [...csrf, { in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        summary: 'Rename / enable / disable',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/emails/batch': {
      post: {
        tags: ['emails'],
        summary: 'Schedule a batch of emails',
        parameters: [
          ...csrf,
          {
            in: 'header',
            name: 'Idempotency-Key',
            required: true,
            schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,128}$' },
          },
        ],
        requestBody: { required: true, ...json(ref('ScheduleBatchRequest'), scheduleExample) },
        responses: {
          '201': {
            description: 'Created',
            ...json({ type: 'object', properties: { data: ref('ScheduleResult') } }),
          },
          '200': {
            description: 'Idempotent replay of an earlier identical request',
            ...json({ type: 'object', properties: { data: ref('ScheduleResult') } }),
          },
          '409': { description: 'Idempotency-Key reused with a different payload', ...json(ref('Error')) },
          ...errors,
        },
      },
    },
    '/api/emails': {
      post: {
        tags: ['emails'],
        summary: 'Schedule a single email (`to` instead of `recipients`)',
        parameters: [
          ...csrf,
          { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } },
        ],
        responses: { '201': { description: 'Created' }, ...errors },
      },
    },
    '/api/emails/scheduled': {
      get: {
        tags: ['emails'],
        parameters: page,
        summary: 'Pending emails (SCHEDULED, PROCESSING, SENDING, RETRYING), soonest first',
        responses: {
          '200': json({
            type: 'object',
            properties: { data: { type: 'array', items: ref('EmailListItem') }, meta: ref('PageMeta') },
          }),
        },
      },
    },
    '/api/emails/sent': {
      get: {
        tags: ['emails'],
        parameters: page,
        summary: 'Finished emails (SENT, FAILED), newest first',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/emails/failed': {
      get: {
        tags: ['emails'],
        parameters: page,
        summary: 'FAILED emails only',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/emails/counts': {
      get: {
        tags: ['emails'],
        summary: 'Counts per view and status',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/emails/search': {
      get: {
        tags: ['search'],
        parameters: [{ in: 'query', name: 'q', schema: { type: 'string' } }, ...page],
        summary:
          'Full-text search (Elasticsearch, scoped to the user; falls back to PostgreSQL if ES is down)',
        responses: { '200': { description: '`meta.source` is `elasticsearch` or `database`' } },
      },
    },
    '/api/emails/{id}': {
      get: {
        tags: ['emails'],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        summary: 'Email detail with sanitised body, attachments and status timeline',
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found (or not yours)' } },
      },
    },
    '/api/emails/{id}/cancel': {
      post: {
        tags: ['emails'],
        parameters: [...csrf, { in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        summary: 'Cancel a SCHEDULED or RETRYING email',
        responses: {
          '200': { description: 'Cancelled' },
          '409': { description: 'Already processing or finished' },
        },
      },
    },
    '/api/attachments': {
      post: {
        tags: ['attachments'],
        parameters: csrf,
        summary: 'Upload one file (multipart field `file`)',
        responses: {
          '201': { description: 'Uploaded' },
          '413': { description: 'Too large' },
          '415': { description: 'Type not allowed' },
        },
      },
    },
    '/api/attachments/{id}/content': {
      get: {
        tags: ['attachments'],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        summary: 'Download (owner only)',
        responses: { '200': { description: 'File' } },
      },
    },
    '/api/slack/status': {
      get: {
        tags: ['slack'],
        summary: 'Slack configuration and connection status',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/slack/oauth/start': {
      get: {
        tags: ['slack'],
        summary: 'Begin Slack OAuth (302 to Slack)',
        responses: { '302': { description: 'Redirect' } },
      },
    },
    '/api/slack/oauth/callback': {
      get: {
        tags: ['slack'],
        security: [],
        summary: 'Slack OAuth callback',
        responses: { '303': { description: 'Redirect to /settings' } },
      },
    },
    '/api/slack/test': {
      post: {
        tags: ['slack'],
        parameters: csrf,
        summary: 'Send a test notification',
        responses: { '200': { description: 'Sent' }, '502': { description: 'Slack rejected the message' } },
      },
    },
    '/api/slack/connection': {
      delete: {
        tags: ['slack'],
        parameters: csrf,
        summary: 'Disconnect (revokes the token)',
        responses: { '204': { description: 'Disconnected' } },
      },
    },
    '/api/slack/events': {
      post: {
        tags: ['slack'],
        security: [],
        summary: 'Slack Events API (signature verified): app_uninstalled / tokens_revoked',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/queue/stats': {
      get: {
        tags: ['queue'],
        summary: 'Status counts; raw BullMQ counts for admins',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/admin/queues': {
      get: {
        tags: ['queue'],
        summary: 'Bull Board UI (ADMIN_EMAILS only)',
        responses: { '200': { description: 'HTML' }, '403': { description: 'Not an admin' } },
      },
    },
  },
};
