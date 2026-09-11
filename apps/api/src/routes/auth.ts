import type { FastifyInstance } from 'fastify';
import { integrations, loginCodes, sessions, users } from '@avail/db';
import { config, isEmailAllowed, normalizeEmail } from '@avail/shared/config';
import {
  encrypt,
  generateLoginCode,
  hashCode,
  hmac,
  safeEqual,
  signToken,
} from '@avail/shared/crypto';
import { id, newIntegrationId } from '@avail/shared/ids';
import { createLogger } from '@avail/shared/logger';
import {
  HttpError,
  endSession,
  publicUser,
  requireAuth,
  resolveUser,
  startSession,
  upsertUser,
} from '../lib/auth.ts';
import { github } from '../lib/github.ts';
import { google } from '../lib/google.ts';
import { loginCodeMail, sendMail } from '../lib/mailer.ts';

const log = createLogger('auth');

/** Simple in-memory throttle for code requests, keyed by email. */
const requestTimes = new Map<string, number[]>();
const MAX_REQUESTS_PER_WINDOW = 5;
const WINDOW_MS = 10 * 60 * 1000;

function throttle(email: string): void {
  const now = Date.now();
  const recent = (requestTimes.get(email) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    throw new HttpError(429, 'Too many sign-in attempts. Try again later.', 'rate_limited');
  }
  recent.push(now);
  requestTimes.set(email, recent);
}

/** Short-lived signed state shared by every OAuth round trip. */
function oauthState(intent: string): string {
  const nonce = `${intent}:${Date.now()}`;
  return `${Buffer.from(nonce).toString('base64url')}.${hmac(nonce, 'oauth')}`;
}

function verifyOauthState(state: string): { intent: string } | null {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  const nonce = Buffer.from(payload, 'base64url').toString('utf8');
  if (!safeEqual(hmac(nonce, 'oauth'), signature)) return null;
  const [intent, issuedAt] = nonce.split(':');
  if (Date.now() - Number(issuedAt) > 10 * 60 * 1000) return null;
  return { intent };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Public: what sign-in methods this install supports. */
  app.get('/api/auth/config', async () => ({
    allowedDomains: config.allowedEmailDomains,
    emailSignIn: true,
    githubSignIn: Boolean(config.github.clientId && config.github.clientSecret),
    googleSignIn: google.configured,
    devEcho: config.authDevEcho,
    mailDelivery: config.smtpUrl ? 'smtp' : 'console',
  }));

  /** Step 1 — request a one-time code. */
  app.post<{ Body: { email?: string } }>('/api/auth/login', async (request) => {
    const email = normalizeEmail(request.body?.email ?? '');
    if (!email || !email.includes('@')) {
      throw new HttpError(400, 'A valid email address is required', 'invalid_email');
    }
    if (!isEmailAllowed(email)) {
      throw new HttpError(
        403,
        `Sign-in is restricted to ${config.allowedEmailDomains
          .map((d) => `@${d}`)
          .join(' and ')} addresses`,
        'domain_not_allowed'
      );
    }
    throttle(email);

    const code = generateLoginCode();
    loginCodes.create({
      id: id('code'),
      email,
      code_hash: hashCode(code),
      expires_at: Date.now() + config.loginCodeTtlMs,
    });

    const { delivered } = await sendMail(loginCodeMail(email, code)).catch(
      (err) => {
        log.error('Mail delivery failed:', err.message);
        return { delivered: false };
      }
    );

    return {
      ok: true,
      email,
      delivered,
      expiresInMs: config.loginCodeTtlMs,
      // Without SMTP configured the code has nowhere to go but the response.
      code: !delivered && config.authDevEcho ? code : undefined,
    };
  });

  /** Step 2 — exchange the code for a session. */
  app.post<{ Body: { email?: string; code?: string; client?: string } }>(
    '/api/auth/verify',
    async (request, reply) => {
      const email = normalizeEmail(request.body?.email ?? '');
      const code = (request.body?.code ?? '').trim();
      if (!email || !code) {
        throw new HttpError(400, 'Email and code are required', 'invalid_request');
      }

      const record = loginCodes.latestForEmail(email);
      if (!record) {
        throw new HttpError(400, 'Request a new sign-in code', 'code_not_found');
      }
      if (record.expires_at < Date.now()) {
        throw new HttpError(400, 'That code has expired', 'code_expired');
      }
      if (record.attempts >= 5) {
        throw new HttpError(429, 'Too many attempts — request a new code', 'too_many_attempts');
      }
      if (!safeEqual(record.code_hash, hashCode(code))) {
        loginCodes.bumpAttempts(record.id);
        throw new HttpError(400, 'That code is not correct', 'invalid_code');
      }

      loginCodes.consume(record.id);
      const user = upsertUser(email);
      const sessionId = startSession(reply, user, request.headers['user-agent']);
      log.info(`${user.email} signed in`);

      // The CLI has no cookie jar, so it receives the bearer token directly.
      const token =
        request.body?.client === 'cli' ? signToken(sessionId) : undefined;
      return { user: publicUser(user), token };
    }
  );

  app.post('/api/auth/logout', async (request, reply) => {
    endSession(request, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const user = resolveUser(request);
    if (!user) throw new HttpError(401, 'Not signed in', 'unauthorized');
    return {
      user: publicUser(user),
      integrations: integrations.forUser(user.id).map((i) => ({
        id: i.id,
        provider: i.provider,
        kind: i.kind,
        login: i.login,
        avatarUrl: i.avatar_url,
        createdAt: i.created_at,
      })),
    };
  });

  app.get('/api/auth/sessions', { preHandler: requireAuth }, async (request) => ({
    sessions: [],
    currentSessionId: request.sessionId,
  }));

  /* ------------------------------------------------------- GitHub OAuth */

  const redirectUri = `${config.apiUrl}/api/auth/github/callback`;

  /**
   * `intent=signin` signs the user in (subject to the domain allow-list),
   * `intent=connect` attaches the GitHub account to the signed-in user.
   */
  app.get<{ Querystring: { intent?: string } }>(
    '/api/auth/github/start',
    async (request, reply) => {
      if (!config.github.clientId) {
        throw new HttpError(400, 'GitHub OAuth is not configured', 'oauth_unavailable');
      }
      const intent = request.query.intent === 'connect' ? 'connect' : 'signin';
      return reply.redirect(
        github.oauthAuthorizeUrl(redirectUri, oauthState(intent))
      );
    }
  );

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/api/auth/github/callback',
    async (request, reply) => {
      const { code, state } = request.query;
      const fail = (message: string) =>
        reply.redirect(
          `${config.dashboardUrl}/login?error=${encodeURIComponent(message)}`
        );

      if (!code || !state) return fail('Missing OAuth response');
      const parsed = verifyOauthState(state);
      if (!parsed) return fail('OAuth state expired — try again');

      let token: string;
      try {
        token = await github.exchangeOAuthCode(code, redirectUri);
      } catch (err) {
        return fail((err as Error).message);
      }

      const profile = await github.user(token);
      const email = profile.email ?? (await github.primaryEmail(token));

      if (parsed.intent === 'signin') {
        if (!email) {
          return fail('Your GitHub account has no verified email address');
        }
        if (!isEmailAllowed(email)) {
          return fail(
            `${email} is not an @${config.allowedEmailDomains[0]} address`
          );
        }
        const user = upsertUser(email, {
          name: profile.name,
          avatar_url: profile.avatar_url,
        });
        startSession(reply, user, request.headers['user-agent']);
        saveIntegration(user.id, profile, token);
        log.info(`${user.email} signed in via GitHub`);
        return reply.redirect(`${config.dashboardUrl}/`);
      }

      const user = resolveUser(request);
      if (!user) return fail('Sign in before connecting GitHub');
      saveIntegration(user.id, profile, token);
      return reply.redirect(`${config.dashboardUrl}/settings/git?connected=1`);
    }
  );

  /* ------------------------------------------------------- Google OAuth */

  const googleRedirectUri = `${config.apiUrl}/api/auth/google/callback`;

  /** Google is identity only — it grants no repository access. */
  app.get('/api/auth/google/start', async (_request, reply) => {
    if (!google.configured) {
      throw new HttpError(
        400,
        'Google sign-in is not configured',
        'oauth_unavailable'
      );
    }
    return reply.redirect(
      google.authorizeUrl(googleRedirectUri, oauthState('signin'))
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/google/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;
      const fail = (message: string) =>
        reply.redirect(
          `${config.dashboardUrl}/login?error=${encodeURIComponent(message)}`
        );

      if (error) return fail(`Google sign-in was cancelled (${error})`);
      if (!code || !state) return fail('Missing OAuth response');
      if (!verifyOauthState(state)) return fail('OAuth state expired — try again');

      let identity;
      try {
        identity = await google.exchangeCode(code, googleRedirectUri);
      } catch (err) {
        return fail((err as Error).message);
      }

      if (!isEmailAllowed(identity.email)) {
        return fail(
          `${identity.email} is not ${config.allowedEmailDomains
            .map((d) => `an @${d}`)
            .join(' or ')} address`
        );
      }

      const user = upsertUser(identity.email, {
        name: identity.name,
        avatar_url: identity.picture,
      });
      startSession(reply, user, request.headers['user-agent']);
      log.info(`${user.email} signed in via Google`);
      return reply.redirect(`${config.dashboardUrl}/`);
    }
  );
}

function saveIntegration(
  userId: string,
  profile: { login: string; avatar_url: string },
  token: string
): void {
  const existing = integrations
    .forUser(userId)
    .find((i) => i.provider === 'github' && i.login === profile.login);
  if (existing) integrations.delete(existing.id);

  integrations.create({
    id: newIntegrationId(),
    user_id: userId,
    provider: 'github',
    kind: 'oauth',
    login: profile.login,
    avatar_url: profile.avatar_url,
    token_enc: encrypt(token, 'git-token'),
    scopes: 'repo,admin:repo_hook',
    created_at: Date.now(),
  });
}
