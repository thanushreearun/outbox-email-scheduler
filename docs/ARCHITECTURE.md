# Architecture and design notes

How the scheduler works and why it is built this way. For setup, see the [README](../README.md) and [LOCAL_SETUP.md](LOCAL_SETUP.md).

## Processes and data

```
Browser (React) ──/api──▶ API (Express) ──1. insert rows──▶ PostgreSQL
                                 └────────2. add delayed jobs──▶ Redis (BullMQ)
Worker (BullMQ) ◀── due jobs ── Redis
   ├─ claims rows, records status ─▶ PostgreSQL
   ├─ reserves hourly quota and send slots (Lua) ─▶ Redis
   ├─ sends via SMTP ─▶ Ethereal
   ├─ rate-limit alert ─▶ Slack webhook
   └─ indexes ─▶ Elasticsearch
```

- **PostgreSQL** is the source of truth for users, sessions, senders, batches, emails, status history, Slack connections and rate-limit events.
- **Redis** holds state that can be rebuilt: BullMQ jobs (payload is only `{ emailId }`), quota counters and spacing cursors. It runs with AOF persistence and `noeviction`.
- **Elasticsearch** is a search index derived from PostgreSQL.
- The **API** (`src/server.ts`) and **worker** (`src/worker.ts`) share one codebase and can be restarted or scaled independently.

## Email lifecycle

```
SCHEDULED → PROCESSING → SENDING → SENT
     │           │           ├─ transient error → RETRYING → PROCESSING …
     │           │           └─ permanent error / attempts used up → FAILED
     │           └─ hourly limit reached → SCHEDULED (deferredUntil set)
     └─ user cancels → CANCELLED
```

Every change goes through `transitionEmail` (`modules/emails/email.repository.ts`). It is a conditional `UPDATE … WHERE status IN (…)`, optionally also matching the worker's claim token, so when two workers race exactly one wins. Each change bumps a version number and writes an audit row in the same transaction. Transitions outside the table in `status.ts` throw.

## Scheduling without cron

Each email is one BullMQ delayed job with ID `email_<uuid>`, delayed by `scheduledAt − now`. Housekeeping uses BullMQ job schedulers with fixed `every` intervals. Those schedules are stored in Redis, so there is one run per interval no matter how many workers are up. The housekeeping jobs are:

- outbox reconciliation
- search reindexing
- Slack retries
- session cleanup

**Database and queue consistency.** The API commits the email rows with `enqueuedAt = NULL`, then adds the jobs and stamps `enqueuedAt`. If Redis is down or the API crashes in between, the rows stay unstamped. The worker's reconciler adds the missing jobs at startup and on each interval. Adding an existing job ID does nothing, so retries are safe. At startup the worker also checks every pending row:
- A missing job is re-created from the stored time.
- A job BullMQ marked failed or completed while the row is still pending is replaced with a new job, delayed until the stored time.

**Restarts.** Delayed jobs live in Redis. Any job that has to be re-created takes its delay from PostgreSQL, so a restart never shifts a scheduled time. Emails that came due while everything was stopped are sent as soon as the worker starts.

**Due-time guard.** Before claiming an email, the worker checks the stored due time (`scheduledAt`, or `deferredUntil` after a rate-limit deferral). If a job becomes runnable early — a manual retry in Bull Board, a recovery path, or clock skew — the job is moved back to the delayed set until that time. The email is not sent, keeps its `SCHEDULED` status, and uses no retry attempt.

**Times and timezones.** The browser turns the picked local date/time into a UTC ISO timestamp. The API requires an explicit timezone and rejects missing or malformed values, so a bad value can never become "send now". All storage and comparisons are UTC. In the compose screen, immediate delivery only happens through the button labelled **Send now**; once a time is picked, that button reads **Schedule** and uses the picked time.

## Idempotency and duplicate sends

1. **Repeated API requests.** Requests need an `Idempotency-Key`. Same key and same payload returns the original result; same key with a different payload returns `409`.
2. **Duplicate recipients.** Recipients are normalised and de-duplicated, and `(batchId, recipientEmail)` is unique.
3. **Re-delivered jobs.** Re-running a job for a finished email has no side effect.
4. **Crash before sending.** A row left in `PROCESSING` is safely claimed again.
5. **Crash during sending.** `SENDING` is written just before the SMTP call. A `SENDING` row older than all SMTP timeouts (2 minutes) means the worker died mid-send. The provider may already have accepted the message, so the email is marked `FAILED` with code `DELIVERY_UNCERTAIN` instead of being sent again.

SMTP and the database cannot share a transaction, so exactly-once delivery is impossible. The system avoids duplicates everywhere except that one window, where it chooses at-most-once and shows the uncertainty in the UI. Each message also carries a fixed `Message-ID` (`<emailId@host>`).

## Rate limiting

**Hourly limits** (`queue/rate-limiter.ts`):
- One Lua script atomically checks the per-sender, global and optional per-batch counters for the current UTC hour, using Redis's clock.
- If any limit is full, the script books the first future hour that has room. The job is moved there with `job.moveToDelayed()` and `DelayedError`. This uses no retry attempt, and the job is never dropped.
- Jobs moved into the same hour are spread out by their booking position, which keeps their order.

**What counts towards the limit.** Each SMTP attempt counts, because providers throttle attempts. A re-delivered job reuses its existing reservation. Capacity is returned if an email is cancelled or fails before sending. Counters expire automatically.

**Minimum delay** (`queue/spacing.ts`):
- A second Lua script hands out per-sender send slots from a shared cursor.
- A worker starts SMTP only inside its slot (slot to slot + 200 ms). If it wakes later than that, it takes a new slot.
- So two sends from one sender never start closer together than the configured delay, across all workers. The real gap is the delay plus up to 200 ms.

**Slack alerts.** The first job to hit a limit in a given hour inserts a `RateLimitEvent` row; the unique key makes later inserts no-ops. Only that first job posts to Slack. The message includes the sender, the limit, the UTC window and the resume time, but no recipients or content.

## Search

Documents are indexed with `version_type: external`, so an older write can never replace a newer one. Rows where `indexedVersion < version` are re-indexed by the worker, so an Elasticsearch outage only delays search.

Every query filters on the signed-in user's ID server-side, and results are loaded back from PostgreSQL with that filter applied again. If Elasticsearch is down, search falls back to PostgreSQL.

## Security

- **Google sign-in:** authorization code with PKCE, a single-use `state` bound to an HttpOnly cookie, and a `nonce` checked in the signed ID token. A verified email is required.
- **Sessions:** stored server-side; only a SHA-256 of the cookie value is kept.
- **CSRF:** SameSite=Lax cookie, an Origin allow-list, and a session-bound token sent as `X-CSRF-Token`.
- **Slack:** requests only the `incoming-webhook` scope. Tokens and webhook URLs are encrypted with AES-256-GCM. Revoked webhooks are detected.
- **Email HTML:** sanitised on write and again before rendering.
- **Attachments:** checked by magic bytes and served only to their owner.

## Limitations

- At-most-once delivery for the crash-during-SMTP window (see above).
- An orphaned email can wait up to `RECONCILE_INTERVAL_MS` before its job is restored.
- The Lua scripts build their keys internally, so they need single-node or primary/replica Redis, not Redis Cluster.
- Order among rate-limited jobs is approximate when several workers book at the same moment.
- Attachments are stored on local disk, so the API and worker must run on the same host.
- HTTP request rate limiting uses an in-memory store per API instance. Email limits are always shared through Redis.
