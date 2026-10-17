/**
 * Test environment. Integration tests use REAL PostgreSQL (database `outbox_test`) and
 * REAL Redis (logical DB 15, unique key prefix) from docker-compose. SMTP, Slack and, in
 * most tests, Elasticsearch are replaced by in-process fakes; the real-ES test is skipped
 * automatically when Elasticsearch is not reachable.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgresql://outbox:outbox@localhost:5433/outbox_test?schema=public';
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.ELASTICSEARCH_URL ??= 'http://localhost:9200';
process.env.ELASTICSEARCH_INDEX = 'emails_test';
process.env.QUEUE_PREFIX = `test${process.pid}`;
process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-1234567890';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.API_PUBLIC_URL = 'http://localhost:5173';
process.env.MIN_DELAY_BETWEEN_EMAILS_MS = '0';
process.env.MAX_EMAILS_PER_HOUR_PER_SENDER = '100';
process.env.MAX_EMAILS_PER_HOUR_GLOBAL = '200';
process.env.EMAIL_MAX_ATTEMPTS = '3';
process.env.EMAIL_BACKOFF_MS = '200';
process.env.ETHEREAL_USER = 'test-sender@ethereal.test';
process.env.ETHEREAL_PASS = 'not-a-real-password';
process.env.UPLOAD_DIR = './uploads-test';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.SLACK_CLIENT_ID;
