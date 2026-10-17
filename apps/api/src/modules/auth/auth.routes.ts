import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config, env } from '../../config/env.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import type { Db } from '../../lib/prisma.js';
import { csrfTokenFor } from '../../middleware/csrf.js';
import type { SenderService } from '../senders/sender.service.js';
import type { GoogleAuthService } from './google.service.js';
import { SESSION_COOKIE, sessionCookieOptions, type SessionService } from './session.service.js';

const STATE_COOKIE = 'outbox_oauth_state';

function loginRedirect(res: Response, error: string) {
  const url = new URL('/login', env.FRONTEND_URL);
  url.searchParams.set('error', error);
  res.redirect(303, url.toString());
}

export function authRouter(deps: {
  db: Db;
  google: GoogleAuthService | null;
  sessions: SessionService;
  senders: SenderService;
}): Router {
  const r = Router();

  r.get('/config', (_req, res) => {
    res.json({ data: { googleConfigured: Boolean(deps.google) } });
  });

  r.get('/google', async (_req, res) => {
    if (!deps.google) return loginRedirect(res, 'google_not_configured');
    const { url, state } = await deps.google.begin();
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: 10 * 60_000,
    });
    res.redirect(302, url);
  });

  r.get('/google/callback', async (req: Request, res: Response) => {
    res.clearCookie(STATE_COOKIE, { path: '/api/auth' });
    if (!deps.google) return loginRedirect(res, 'google_not_configured');
    const q = z
      .object({
        code: z.string().min(1).max(2048).optional(),
        state: z.string().max(256).optional(),
        error: z.string().max(100).optional(),
      })
      .parse(req.query);
    if (q.error) return loginRedirect(res, q.error === 'access_denied' ? 'access_denied' : 'oauth_failed');
    if (!q.code || !q.state) return loginRedirect(res, 'oauth_failed');

    try {
      const profile = await deps.google.complete({
        code: q.code,
        state: q.state,
        cookieState: req.cookies?.[STATE_COOKIE] as string | undefined,
      });
      const user = await deps.db.user.upsert({
        where: { googleSub: profile.sub },
        create: {
          googleSub: profile.sub,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.picture,
        },
        update: { email: profile.email, name: profile.name, avatarUrl: profile.picture },
      });
      await deps.senders.ensureDefaultSender(user.id, user.name);
      const session = await deps.sessions.create(user.id, req.get('user-agent'));
      res.cookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
      req.log.info({ userId: user.id }, 'user signed in');
      res.redirect(303, new URL('/', env.FRONTEND_URL).toString());
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'google oauth callback failed');
      loginRedirect(res, err instanceof AppError ? err.code.toLowerCase() : 'oauth_failed');
    }
  });

  r.post('/logout', async (req, res) => {
    if (req.auth) await deps.sessions.destroy(req.auth.sessionId);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.status(204).end();
  });

  return r;
}

/** GET /api/me — the authenticated user plus the session-bound CSRF token. */
export function meHandler(req: Request, res: Response) {
  if (!req.auth) throw unauthorized();
  res.json({
    data: {
      user: req.auth.user,
      csrfToken: csrfTokenFor(req.auth.sessionId),
      isAdmin: config.adminEmails.has(req.auth.user.email.toLowerCase()),
    },
  });
}
