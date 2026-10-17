import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The CSRF token is bound to the session: HMAC(sessionId). It is not a secret from the user. */
export function csrfTokenFor(sessionId: string): string {
  return hmac(`csrf:${sessionId}`);
}

const allowedOrigins = new Set([new URL(env.FRONTEND_URL).origin, new URL(env.API_PUBLIC_URL).origin]);

/**
 * Defence in depth for cookie-authenticated, state-changing requests:
 * 1. SameSite=Lax session cookie (set elsewhere) blocks most cross-site sends.
 * 2. If the browser sends Origin, it must be one of our origins.
 * 3. Synchronizer token: the header must equal the session-bound token, which the SPA
 *    obtains from GET /api/me (a same-origin JSON response other sites cannot read).
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method) || !req.auth) return next();

  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    return next(new AppError(403, 'CSRF_ORIGIN', 'Cross-origin request rejected'));
  }
  const header = req.get(CSRF_HEADER);
  if (!header || !safeEqual(header, csrfTokenFor(req.auth.sessionId))) {
    return next(new AppError(403, 'CSRF_TOKEN', 'Missing or invalid CSRF token'));
  }
  next();
}
