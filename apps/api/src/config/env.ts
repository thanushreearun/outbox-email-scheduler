import { z } from 'zod';

/**
 * Environment configuration, validated once at startup.
 *
 * Policy: secrets that protect data (SESSION_SECRET, ENCRYPTION_KEY) are always required.
 * External integrations (Google, Slack, Ethereal) are optional in development so the app
 * can boot and show a clear "not configured" state, but Google OAuth is required in
 * production because the app is unusable without login.
 */

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(4000, 1, 65535),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    FRONTEND_URL: z.string().url().default('http://localhost:5173'),
    API_PUBLIC_URL: z.string().url().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
    ELASTICSEARCH_INDEX: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'ELASTICSEARCH_INDEX must be a lowercase index name')
      .default('emails'),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('outbox'),

    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    ENCRYPTION_KEY: z
      .string()
      .refine(
        (v) => Buffer.from(v, 'base64').length === 32,
        'ENCRYPTION_KEY must be 32 bytes, base64-encoded',
      ),
    SESSION_TTL_HOURS: int(168, 1, 24 * 90),
    COOKIE_SECURE: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).optional()),
    ADMIN_EMAILS: z.preprocess(emptyToUndefined, z.string().optional()),

    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_CALLBACK_URL: optionalUrl,

    ETHEREAL_HOST: z.string().default('smtp.ethereal.email'),
    ETHEREAL_PORT: int(587, 1, 65535),
    ETHEREAL_USER: optionalString,
    ETHEREAL_PASS: optionalString,
    ETHEREAL_FROM_NAME: z.string().default('Outbox Scheduler'),

    WORKER_CONCURRENCY: int(5, 1, 100),
    MIN_DELAY_BETWEEN_EMAILS_MS: int(2000, 0, 3_600_000),
    MAX_EMAILS_PER_HOUR_PER_SENDER: int(100, 1, 1_000_000),
    MAX_EMAILS_PER_HOUR_GLOBAL: int(200, 1, 10_000_000),
    EMAIL_MAX_ATTEMPTS: int(5, 1, 20),
    EMAIL_BACKOFF_MS: int(30_000, 100, 3_600_000),
    MAX_RECIPIENTS_PER_BATCH: int(5000, 1, 100_000),
    RECONCILE_INTERVAL_MS: int(60_000, 5_000, 3_600_000),
    RATE_LIMIT_WINDOW_MS: int(3_600_000, 1_000, 86_400_000),

    SLACK_CLIENT_ID: optionalString,
    SLACK_CLIENT_SECRET: optionalString,
    SLACK_REDIRECT_URL: optionalUrl,
    SLACK_SIGNING_SECRET: optionalString,

    UPLOAD_DIR: z.string().default('./uploads'),
    MAX_ATTACHMENT_BYTES: int(5 * 1024 * 1024, 1024, 25 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    const googleKeys = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CALLBACK_URL];
    if (env.NODE_ENV === 'production' && googleKeys.some((k) => !k)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL are required in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === 'false') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'COOKIE_SECURE=false is not allowed in production',
      });
    }
    if (env.MAX_EMAILS_PER_HOUR_PER_SENDER > env.MAX_EMAILS_PER_HOUR_GLOBAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MAX_EMAILS_PER_HOUR_PER_SENDER cannot exceed MAX_EMAILS_PER_HOUR_GLOBAL',
      });
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  // API_PORT wins over PORT: dev tools and PaaS runners often inject PORT for another process.
  const parsed = schema.safeParse({ ...process.env, PORT: process.env.API_PORT ?? process.env.PORT });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`)
      .join('\n');
    // Logger depends on config, so this is the one place we write directly to stderr.
    console.error(`\nInvalid environment configuration:\n${details}\n\nSee .env.example and README.md.\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export const config = {
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  adminEmails: new Set(
    (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
  google:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          callbackUrl: env.GOOGLE_CALLBACK_URL,
        }
      : null,
  slack:
    env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_REDIRECT_URL
      ? {
          clientId: env.SLACK_CLIENT_ID,
          clientSecret: env.SLACK_CLIENT_SECRET,
          redirectUrl: env.SLACK_REDIRECT_URL,
          signingSecret: env.SLACK_SIGNING_SECRET ?? null,
        }
      : null,
  ethereal:
    env.ETHEREAL_USER && env.ETHEREAL_PASS
      ? { host: env.ETHEREAL_HOST, port: env.ETHEREAL_PORT, user: env.ETHEREAL_USER, pass: env.ETHEREAL_PASS }
      : null,
} as const;
