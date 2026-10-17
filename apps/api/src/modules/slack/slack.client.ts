import { createHmac } from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';

/**
 * Minimal Slack Web API client for the OAuth v2 "incoming-webhook" installation.
 *
 * Why incoming-webhook: it is the narrowest scope that can post messages. Slack shows a
 * channel picker during authorization, so the user selects the destination channel in
 * Slack itself, and the app never needs read access to channels or messages.
 */
export const SLACK_SCOPES = ['incoming-webhook'] as const;

export interface SlackOAuthResult {
  accessToken: string | null;
  scope: string;
  botUserId: string | null;
  appId: string | null;
  teamId: string;
  teamName: string | null;
  authedUserId: string | null;
  webhook: { url: string; channel: string | null; channelId: string | null; configurationUrl: string | null };
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    /** `revoked`: the installation/webhook no longer works and must be reconnected. */
    public readonly kind: 'revoked' | 'transient' | 'invalid',
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

type FetchFn = typeof fetch;

export class SlackClient {
  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; redirectUrl: string },
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  authorizeUrl(state: string): string {
    const url = new URL('https://slack.com/oauth/v2/authorize');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('scope', SLACK_SCOPES.join(','));
    url.searchParams.set('redirect_uri', this.cfg.redirectUrl);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<SlackOAuthResult> {
    const res = await this.fetchFn('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        redirect_uri: this.cfg.redirectUrl,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      scope?: string;
      bot_user_id?: string;
      app_id?: string;
      team?: { id: string; name?: string };
      authed_user?: { id?: string };
      incoming_webhook?: { url: string; channel?: string; channel_id?: string; configuration_url?: string };
    };
    if (!body.ok || !body.team?.id)
      throw new SlackApiError(`Slack OAuth failed: ${body.error ?? 'unknown'}`, 'invalid');
    if (!body.incoming_webhook?.url) {
      throw new SlackApiError(
        'Slack did not return an incoming webhook; a channel must be selected',
        'invalid',
      );
    }
    return {
      accessToken: body.access_token ?? null,
      scope: body.scope ?? '',
      botUserId: body.bot_user_id ?? null,
      appId: body.app_id ?? null,
      teamId: body.team.id,
      teamName: body.team.name ?? null,
      authedUserId: body.authed_user?.id ?? null,
      webhook: {
        url: body.incoming_webhook.url,
        channel: body.incoming_webhook.channel ?? null,
        channelId: body.incoming_webhook.channel_id ?? null,
        configurationUrl: body.incoming_webhook.configuration_url ?? null,
      },
    };
  }

  async postWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
    if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
      throw new SlackApiError('Refusing to post to a non-Slack webhook URL', 'invalid');
    }
    let res: Response;
    try {
      res = await this.fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new SlackApiError(`Slack unreachable: ${(err as Error).message}`, 'transient');
    }
    if (res.ok) return;
    const text = (await res.text().catch(() => '')).slice(0, 100);
    // Documented webhook errors: 404 no_service / channel_not_found, 403 action_prohibited,
    // 410 channel_is_archived => the installation is gone or unusable.
    if ([403, 404, 410].includes(res.status))
      throw new SlackApiError(`Slack webhook rejected: ${text}`, 'revoked');
    if (res.status === 429 || res.status >= 500)
      throw new SlackApiError(`Slack temporary error ${res.status}`, 'transient');
    throw new SlackApiError(`Slack webhook error ${res.status}: ${text}`, 'invalid');
  }

  /** Best-effort uninstall of the token on disconnect. */
  async revoke(token: string): Promise<void> {
    await this.fetchFn('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
    });
  }
}

/** Verifies `X-Slack-Signature` (v0 HMAC-SHA256) and rejects requests older than 5 minutes. */
export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  return safeEqual(expected, signature);
}
