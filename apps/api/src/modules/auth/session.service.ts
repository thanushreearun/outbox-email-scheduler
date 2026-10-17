import type { CookieOptions } from 'express';
import { config, env } from '../../config/env.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import type { Db } from '../../lib/prisma.js';
import type { AuthContext } from '../../middleware/auth.js';

export const SESSION_COOKIE = 'outbox_sid';
const TOUCH_INTERVAL_MS = 10 * 60_000;

export function sessionCookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    ...(expires ? { expires } : {}),
  };
}

export class SessionService {
  constructor(private readonly db: Db) {}

  async create(userId: string, userAgent: string | undefined) {
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);
    const session = await this.db.session.create({
      data: { tokenHash: sha256(token), userId, expiresAt, userAgent: userAgent?.slice(0, 300) ?? null },
    });
    return { token, sessionId: session.id, expiresAt };
  }

  async resolve(token: string): Promise<AuthContext | null> {
    if (token.length > 200) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, email: true, name: true, avatarUrl: true } } },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.session
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
    return { sessionId: session.id, user: session.user };
  }

  async destroy(sessionId: string): Promise<void> {
    await this.db.session.deleteMany({ where: { id: sessionId } });
  }

  /** Deletes expired sessions and expired OAuth `state` rows (both are useless once expired). */
  async purgeExpired(): Promise<{ sessions: number; oauthStates: number }> {
    const now = new Date();
    const [sessions, oauthStates] = await this.db.$transaction([
      this.db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      this.db.oAuthState.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);
    return { sessions: sessions.count, oauthStates: oauthStates.count };
  }
}
