import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256 } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { Db } from '../../lib/prisma.js';

const STATE_TTL_MS = 10 * 60_000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

/**
 * Google OAuth 2.0 authorization-code flow with OpenID Connect:
 * - `state` (single-use, hashed in DB, bound to the browser by an HttpOnly cookie)
 * - PKCE S256 code verifier (encrypted in DB, never sent to the browser)
 * - `nonce` checked inside the signature-verified ID token
 * - `email_verified` required
 */
export class GoogleAuthService {
  private readonly client: OAuth2Client;

  constructor(
    private readonly db: Db,
    private readonly cfg: GoogleConfig,
  ) {
    this.client = new OAuth2Client({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.callbackUrl,
    });
  }

  async begin(): Promise<{ url: string; state: string }> {
    const state = randomToken(24);
    const nonce = randomToken(16);
    const { codeVerifier, codeChallenge } = await this.client.generateCodeVerifierAsync();
    if (!codeChallenge) throw new Error('PKCE challenge generation failed');

    await this.db.oAuthState.create({
      data: {
        stateHash: sha256(state),
        provider: 'GOOGLE',
        nonce,
        codeVerifierEncrypted: encryptSecret(codeVerifier),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    const url = this.client.generateAuthUrl({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state,
      prompt: 'select_account',
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
      include_granted_scopes: true,
    });
    return { url: `${url}&nonce=${encodeURIComponent(nonce)}`, state };
  }

  async complete(input: {
    code: string;
    state: string;
    cookieState: string | undefined;
  }): Promise<GoogleProfile> {
    if (!input.cookieState || !safeEqual(input.cookieState, input.state)) {
      throw new AppError(400, 'OAUTH_STATE_MISMATCH', 'Login session mismatch. Please try again.');
    }
    const row = await consumeState(this.db, 'GOOGLE', input.state);
    if (!row?.codeVerifierEncrypted || !row.nonce) {
      throw new AppError(400, 'OAUTH_STATE_INVALID', 'Login link expired or already used. Please try again.');
    }

    const { tokens } = await this.client.getToken({
      code: input.code,
      codeVerifier: decryptSecret(row.codeVerifierEncrypted),
      redirect_uri: this.cfg.callbackUrl,
    });
    if (!tokens.id_token) throw new AppError(400, 'OAUTH_NO_ID_TOKEN', 'Google did not return an ID token');

    const ticket = await this.client.verifyIdToken({ idToken: tokens.id_token, audience: this.cfg.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email)
      throw new AppError(400, 'OAUTH_BAD_TOKEN', 'Invalid Google identity');
    if (payload.nonce !== row.nonce) throw new AppError(400, 'OAUTH_NONCE', 'Invalid login nonce');
    if (!payload.email_verified)
      throw new AppError(403, 'EMAIL_UNVERIFIED', 'Google account email is not verified');

    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name ?? payload.email,
      picture: payload.picture ?? null,
    };
  }
}

/** Atomically marks a state row consumed; returns it only for the first, unexpired use. */
export async function consumeState(db: Db, provider: 'GOOGLE' | 'SLACK', state: string) {
  const stateHash = sha256(state);
  const res = await db.oAuthState.updateMany({
    where: { stateHash, provider, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (res.count !== 1) return null;
  return db.oAuthState.findUnique({ where: { stateHash } });
}
