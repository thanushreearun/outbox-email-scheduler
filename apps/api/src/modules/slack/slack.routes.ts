import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { config, env } from '../../config/env.js';
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, notFound, serviceUnavailable } from '../../lib/errors.js';
import type { Db } from '../../lib/prisma.js';
import { currentUser, requireAuth } from '../../middleware/auth.js';
import { consumeState } from '../auth/google.service.js';
import { buildMessage } from './rate-limit-notifier.js';
import { SlackApiError, verifySlackSignature, type SlackClient } from './slack.client.js';

const STATE_TTL_MS = 10 * 60_000;

function settingsRedirect(res: Response, result: string) {
  const url = new URL('/settings', env.FRONTEND_URL);
  url.searchParams.set('slack', result);
  res.redirect(303, url.toString());
}

/**
 * Slack OAuth v2 flow. The callback may arrive on a different host than the SPA (Slack
 * requires an HTTPS redirect URL, so local development uses a tunnel), meaning the session
 * cookie may not be present there. The connection is therefore bound to the user through
 * the server-side, single-use, 10-minute `state` row created by an authenticated request.
 */
export function slackRouter(deps: { db: Db; slack: SlackClient | null }): Router {
  const r = Router();
  const { db, slack } = deps;

  r.get('/status', requireAuth, async (req, res) => {
    const conn = await db.slackConnection.findUnique({ where: { userId: currentUser(req).id } });
    res.json({
      data: {
        configured: Boolean(slack),
        connected: conn?.status === 'ACTIVE',
        connection: conn
          ? {
              status: conn.status,
              teamName: conn.teamName,
              channelName: conn.channelName,
              configurationUrl: conn.configurationUrl,
              lastError: conn.lastError,
              lastNotifiedAt: conn.lastNotifiedAt?.toISOString() ?? null,
              connectedAt: conn.createdAt.toISOString(),
            }
          : null,
      },
    });
  });

  r.get('/oauth/start', requireAuth, async (req, res) => {
    if (!slack) return settingsRedirect(res, 'not_configured');
    const state = randomToken(24);
    await db.oAuthState.create({
      data: {
        stateHash: sha256(state),
        provider: 'SLACK',
        userId: currentUser(req).id,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    res.redirect(302, slack.authorizeUrl(state));
  });

  r.get('/oauth/callback', async (req, res) => {
    if (!slack) return settingsRedirect(res, 'not_configured');
    const q = z
      .object({
        code: z.string().max(2048).optional(),
        state: z.string().max(256).optional(),
        error: z.string().max(100).optional(),
      })
      .parse(req.query);
    if (q.error) return settingsRedirect(res, q.error === 'access_denied' ? 'denied' : 'error');
    if (!q.code || !q.state) return settingsRedirect(res, 'error');

    const stateRow = await consumeState(db, 'SLACK', q.state);
    if (!stateRow?.userId) return settingsRedirect(res, 'expired');
    // If the callback does carry our session, it must belong to the same user.
    if (req.auth && req.auth.user.id !== stateRow.userId) return settingsRedirect(res, 'error');

    try {
      const result = await slack.exchangeCode(q.code);
      const data = {
        teamId: result.teamId,
        teamName: result.teamName,
        authedUserId: result.authedUserId,
        botUserId: result.botUserId,
        appId: result.appId,
        scopes: result.scope,
        botTokenEncrypted: result.accessToken ? encryptSecret(result.accessToken) : null,
        webhookUrlEncrypted: encryptSecret(result.webhook.url),
        channelId: result.webhook.channelId,
        channelName: result.webhook.channel,
        configurationUrl: result.webhook.configurationUrl,
        status: 'ACTIVE' as const,
        lastError: null,
      };
      await db.slackConnection.upsert({
        where: { userId: stateRow.userId },
        create: { userId: stateRow.userId, ...data },
        update: data,
      });
      req.log.info({ userId: stateRow.userId, teamId: result.teamId }, 'slack connected');
      settingsRedirect(res, 'connected');
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'slack oauth callback failed');
      settingsRedirect(res, 'error');
    }
  });

  r.post('/test', requireAuth, async (req, res) => {
    if (!slack) throw serviceUnavailable('SLACK_NOT_CONFIGURED', 'Slack is not configured on the server');
    const user = currentUser(req);
    const conn = await db.slackConnection.findUnique({ where: { userId: user.id } });
    if (!conn || conn.status !== 'ACTIVE') throw notFound('No active Slack connection');
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const sample = buildMessage({
      limitType: 'SENDER',
      limitValue: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
      windowStart,
      resumesAt: new Date(windowStart.getTime() + 3_600_000),
      senderAccount: { email: 'example-sender@test', displayName: 'Test notification' },
    });
    try {
      await slack.postWebhook(decryptSecret(conn.webhookUrlEncrypted), {
        ...sample,
        text: `[Test] ${sample.text}`,
      });
    } catch (err) {
      if (err instanceof SlackApiError && err.kind === 'revoked') {
        await db.slackConnection.update({
          where: { id: conn.id },
          data: { status: 'REVOKED', lastError: err.message },
        });
      }
      throw new AppError(502, 'SLACK_DELIVERY_FAILED', (err as Error).message);
    }
    await db.slackConnection.update({
      where: { id: conn.id },
      data: { lastNotifiedAt: now, lastError: null },
    });
    res.json({ data: { sent: true } });
  });

  r.delete('/connection', requireAuth, async (req, res) => {
    const conn = await db.slackConnection.findUnique({ where: { userId: currentUser(req).id } });
    if (conn) {
      if (slack && conn.botTokenEncrypted) {
        await slack
          .revoke(decryptSecret(conn.botTokenEncrypted))
          .catch((err: Error) =>
            req.log.warn({ err: err.message }, 'slack token revoke failed; deleting local connection anyway'),
          );
      }
      await db.slackConnection.delete({ where: { id: conn.id } });
    }
    res.status(204).end();
  });

  return r;
}

/**
 * Slack Events API endpoint (mounted with a raw body parser so the signature can be
 * verified). Handles uninstall / revocation so stale connections are flagged immediately.
 */
export function slackEventsHandler(db: Db) {
  return [
    express.raw({ type: 'application/json', limit: '100kb' }),
    async (req: express.Request, res: express.Response) => {
      const signingSecret = config.slack?.signingSecret;
      if (!signingSecret) throw serviceUnavailable('SLACK_NOT_CONFIGURED', 'SLACK_SIGNING_SECRET is not set');
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const valid = verifySlackSignature({
        signingSecret,
        timestamp: req.get('x-slack-request-timestamp'),
        signature: req.get('x-slack-signature'),
        rawBody,
      });
      if (!valid) throw new AppError(401, 'BAD_SIGNATURE', 'Invalid Slack signature');

      const body = JSON.parse(rawBody) as {
        type?: string;
        challenge?: string;
        team_id?: string;
        event?: { type?: string };
      };
      if (body.type === 'url_verification') return res.json({ challenge: body.challenge });
      if (
        body.type === 'event_callback' &&
        body.team_id &&
        ['app_uninstalled', 'tokens_revoked'].includes(body.event?.type ?? '')
      ) {
        await db.slackConnection.updateMany({
          where: { teamId: body.team_id },
          data: { status: 'REVOKED', lastError: `Slack event: ${body.event?.type}` },
        });
      }
      res.status(200).end();
    },
  ];
}
