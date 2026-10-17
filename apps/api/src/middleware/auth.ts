import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { SESSION_COOKIE, type SessionService } from '../modules/auth/session.service.js';

export interface AuthContext {
  sessionId: string;
  user: { id: string; email: string; name: string; avatarUrl: string | null };
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** Resolves the session cookie (if any) into `req.auth`. Never trusts client-sent user IDs. */
export function loadSession(sessions: SessionService) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (token) {
      const auth = await sessions.resolve(token);
      if (auth) req.auth = auth;
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  if (!config.adminEmails.has(req.auth.user.email.toLowerCase())) {
    return next(forbidden('Queue dashboard access is restricted to ADMIN_EMAILS'));
  }
  next();
}

/** Typed accessor for handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthContext['user'] {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}
