import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessions, users } from '@avail/db';
import { config, isEmailAllowed, normalizeEmail } from '@avail/shared/config';
import { signToken, verifyToken } from '@avail/shared/crypto';
import { newSessionId, newUserId } from '@avail/shared/ids';
import type { User } from '@avail/shared/types';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    sessionId?: string;
  }
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'error'
  ) {
    super(message);
  }
}

/**
 * Finds or creates the user for `email`, rejecting addresses outside the
 * allow-listed domains. The first user to sign in owns the workspace.
 */
export function upsertUser(
  email: string,
  profile: { name?: string | null; avatar_url?: string | null } = {}
): User {
  const normalized = normalizeEmail(email);
  if (!isEmailAllowed(normalized)) {
    throw new HttpError(
      403,
      `Only ${config.allowedEmailDomains
        .map((d) => `@${d}`)
        .join(', ')} email addresses can sign in`,
      'domain_not_allowed'
    );
  }

  const existing = users.byEmail(normalized);
  if (existing) {
    if (
      (profile.name && profile.name !== existing.name) ||
      (profile.avatar_url && profile.avatar_url !== existing.avatar_url)
    ) {
      users.update(existing.id, {
        name: profile.name ?? existing.name,
        avatar_url: profile.avatar_url ?? existing.avatar_url,
      });
    }
    users.touchLogin(existing.id);
    return users.byId(existing.id)!;
  }

  const isFirstUser = users.count() === 0;
  const created = users.create({
    id: newUserId(),
    email: normalized,
    name: profile.name ?? normalized.split('@')[0],
    avatar_url: profile.avatar_url ?? null,
    role: isFirstUser ? 'owner' : 'member',
  });
  users.touchLogin(created.id);
  return created;
}

/** Creates a session row and sets the signed session cookie. */
export function startSession(
  reply: FastifyReply,
  user: User,
  userAgent?: string
): string {
  const id = newSessionId();
  const now = Date.now();
  sessions.create({
    id,
    user_id: user.id,
    created_at: now,
    expires_at: now + config.sessionTtlMs,
    user_agent: userAgent ?? null,
  });

  reply.setCookie(config.cookieName, signToken(id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.deploymentScheme === 'https',
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
  return id;
}

export function endSession(request: FastifyRequest, reply: FastifyReply): void {
  const raw = request.cookies[config.cookieName];
  const sessionId = raw ? verifyToken(raw) : null;
  if (sessionId) sessions.delete(sessionId);
  reply.clearCookie(config.cookieName, { path: '/' });
}

/** Resolves the signed-in user from the session cookie or a bearer token. */
export function resolveUser(request: FastifyRequest): User | null {
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const raw = bearer ?? request.cookies[config.cookieName];
  if (!raw) return null;

  const sessionId = verifyToken(raw);
  if (!sessionId) return null;

  const session = sessions.byId(sessionId);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    sessions.delete(session.id);
    return null;
  }

  const user = users.byId(session.user_id);
  if (!user) return null;
  request.sessionId = session.id;
  return user;
}

/** Fastify preHandler that rejects unauthenticated requests. */
export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const user = resolveUser(request);
  if (!user) throw new HttpError(401, 'Authentication required', 'unauthorized');
  request.user = user;
}

/** Fastify preHandler that additionally requires the `owner` role. */
export async function requireOwner(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await requireAuth(request, reply);
  if (request.user?.role !== 'owner') {
    throw new HttpError(403, 'Owner role required', 'forbidden');
  }
}

export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    role: user.role,
    createdAt: user.created_at,
  };
}
