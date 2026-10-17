# Outbox Email Scheduler

Outbox lets a signed-in user compose an email, add recipients by typing or uploading a CSV/text list, and schedule the batch for later. A background worker sends each email at its time through SMTP (Ethereal in development). It enforces a minimum delay between sends and hourly limits per sender, retries temporary failures, and survives restarts without losing or duplicating scheduled work. Emails are searchable, Slack can be notified when a sender hits its hourly limit, and a Bull Board dashboard shows the live queue.

## Tech stack

- Backend: Node.js, TypeScript, Express 5, Prisma, Zod, Pino
- Queue: BullMQ on Redis
- Database: PostgreSQL
- Search: Elasticsearch 8
- Email: Nodemailer with Ethereal SMTP
- Auth and integrations: Google OAuth (OpenID Connect), Slack OAuth, Bull Board
- Frontend: React 18, Vite, Tailwind CSS, TanStack Query, React Hook Form, TipTap
- Tests: Vitest, Supertest, Testing Library
- Local infrastructure: Docker Compose

## Prerequisites

- Node.js 22.9 or newer, and npm 10 or newer
- Docker Desktop (or Docker Engine with Compose v2)
- A Google Cloud OAuth client, needed to sign in
- Optional: a Slack app and an HTTPS tunnel such as cloudflared or ngrok, for Slack notifications

## Setup

Run these from the repository root.

```bash
npm install
```

```bash
cp .env.example .env
```

Fill in `SESSION_SECRET`, `ENCRYPTION_KEY`, the Google values and `ADMIN_EMAILS` in `.env` (see Configuration). Then create a test SMTP mailbox and paste the printed `ETHEREAL_USER` and `ETHEREAL_PASS` into `.env`:

```bash
npm run ethereal:create
```

Start PostgreSQL, Redis and Elasticsearch. The command waits until all three report healthy:

```bash
npm run services:up
```

Generate the Prisma client and apply the database migrations:

```bash
npm run db:generate
```

```bash
npm run db:deploy
```

## Run locally

One terminal runs the API, the worker and the web app together:

```bash
npm run dev
```

To run them in three separate terminals instead, use `npm run dev:api`, `npm run dev:worker` and `npm run dev:web`. All three must be running; the worker is what actually sends emails.

| What | URL |
| --- | --- |
| Web app | http://localhost:5173 |
| API (direct) | http://localhost:4000 |
| Health check | http://localhost:5173/api/health/ready |
| API docs (Swagger) | http://localhost:5173/api/docs |
| Queue dashboard (users listed in `ADMIN_EMAILS`) | http://localhost:5173/admin/queues |

The Vite dev server proxies `/api` and `/admin` to the API, so the browser only talks to port 5173.

## Configuration

All settings live in one `.env` file in the repository root, shared by the API and the worker. `.env.example` lists every variable.

Required:

- `DATABASE_URL`, `REDIS_URL`, `ELASTICSEARCH_URL`: the defaults match `docker-compose.yml`. Postgres is exposed on port 5433.
- `SESSION_SECRET` and `ENCRYPTION_KEY`: generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`: create a Web application OAuth client in Google Cloud Console. Add `http://localhost:5173` as an authorized JavaScript origin and `http://localhost:5173/api/auth/google/callback` as an authorized redirect URI. Without these, the app starts but the login page shows a setup notice.
- `ETHEREAL_USER` and `ETHEREAL_PASS`: from `npm run ethereal:create`.

Optional:

- `ADMIN_EMAILS`: Google account emails allowed to open the queue dashboard.
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `SLACK_SIGNING_SECRET`: from a Slack app with the `incoming-webhook` bot scope. Slack only accepts HTTPS redirect URLs, so expose port 4000 with a tunnel and use `https://<tunnel-host>/api/slack/oauth/callback`.
- Sending limits: `WORKER_CONCURRENCY`, `MIN_DELAY_BETWEEN_EMAILS_MS` (default 2000), `MAX_EMAILS_PER_HOUR_PER_SENDER` (default 100), `MAX_EMAILS_PER_HOUR_GLOBAL` (default 200), `EMAIL_MAX_ATTEMPTS`, `EMAIL_BACKOFF_MS`.

The app validates its configuration at startup and lists anything missing or invalid.

## Testing

The API tests use the running Docker services (a separate `outbox_test` database, Redis database 15 and the `emails_test` index), so start them first with `npm run services:up`.

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run build
```

`npm run build` compiles the API to `apps/api/dist` and the web app to `apps/web/dist`. Run the compiled API and worker with `npm run start -w apps/api` and `npm run start:worker -w apps/api`.

## Important notes

- Ethereal never delivers to real inboxes. It accepts the message and keeps it in a test mailbox; the email detail page links to the captured copy.
- Sign-in is Google-only. The email/password form from the design is shown disabled.
- Slack notifications only work after connecting a real Slack workspace from Settings, through an HTTPS tunnel.
- If a worker crashes during the SMTP transaction itself, that email is marked `FAILED` (`DELIVERY_UNCERTAIN`) rather than sent again, because the provider may already have accepted it.
- Attachments are stored on local disk, so the API and worker must run on the same machine.

Design details, such as how scheduling, idempotency and rate limits work, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
