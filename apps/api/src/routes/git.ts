import type { FastifyInstance } from 'fastify';
import { integrations } from '@avail/db';
import { encrypt, tryDecrypt } from '@avail/shared/crypto';
import { newIntegrationId } from '@avail/shared/ids';
import { HttpError, requireAuth } from '../lib/auth.ts';
import { github } from '../lib/github.ts';

function serialize(row: {
  id: string;
  provider: string;
  kind: string;
  login: string;
  avatar_url: string | null;
  created_at: number;
}) {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    login: row.login,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

export async function gitRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/git/integrations', async (request) => ({
    integrations: integrations.forUser(request.user!.id).map(serialize),
  }));

  /**
   * Connects a GitHub personal access token. This is the path that works
   * without registering an OAuth app — useful for self-hosted installs.
   */
  app.post<{ Body: { token?: string } }>(
    '/api/git/integrations',
    async (request) => {
      const token = request.body?.token?.trim();
      if (!token) throw new HttpError(400, 'A GitHub token is required', 'invalid_token');

      let profile;
      try {
        profile = await github.user(token);
      } catch {
        throw new HttpError(400, 'GitHub rejected that token', 'invalid_token');
      }

      const existing = integrations
        .forUser(request.user!.id)
        .find((i) => i.login === profile.login);
      if (existing) integrations.delete(existing.id);

      const created = integrations.create({
        id: newIntegrationId(),
        user_id: request.user!.id,
        provider: 'github',
        kind: 'pat',
        login: profile.login,
        avatar_url: profile.avatar_url,
        token_enc: encrypt(token, 'git-token'),
        scopes: null,
        created_at: Date.now(),
      });

      return { integration: serialize(created) };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/git/integrations/:id',
    async (request) => {
      const row = integrations.byId(request.params.id);
      if (!row || row.user_id !== request.user!.id) {
        throw new HttpError(404, 'Integration not found', 'not_found');
      }
      integrations.delete(row.id);
      return { ok: true };
    }
  );

  /** Repositories visible to any of the user's connected accounts. */
  app.get<{ Querystring: { q?: string; page?: string } }>(
    '/api/git/repos',
    async (request) => {
      const rows = integrations.forUser(request.user!.id);
      if (!rows.length) {
        throw new HttpError(
          400,
          'Connect a GitHub account first',
          'no_integration'
        );
      }

      const page = Number(request.query.page ?? 1) || 1;
      const seen = new Set<string>();
      const repos = [];

      for (const row of rows) {
        const token = tryDecrypt(row.token_enc, 'git-token');
        if (!token) continue;
        try {
          for (const repo of await github.repos(token, page)) {
            if (seen.has(repo.full_name)) continue;
            seen.add(repo.full_name);
            repos.push({
              id: String(repo.id),
              name: repo.name,
              fullName: repo.full_name,
              private: repo.private,
              description: repo.description,
              defaultBranch: repo.default_branch,
              url: repo.html_url,
              pushedAt: repo.pushed_at,
              owner: repo.owner.login,
              ownerAvatar: repo.owner.avatar_url,
              integrationId: row.id,
              canAdmin: repo.permissions?.admin ?? false,
            });
          }
        } catch (err) {
          request.log.warn(
            `Listing repos for ${row.login} failed: ${(err as Error).message}`
          );
        }
      }

      const query = request.query.q?.toLowerCase();
      const filtered = query
        ? repos.filter((r) => r.fullName.toLowerCase().includes(query))
        : repos;

      filtered.sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1));
      return { repos: filtered, page };
    }
  );

  app.get<{ Params: { owner: string; repo: string } }>(
    '/api/git/repos/:owner/:repo/branches',
    async (request) => {
      const fullName = `${request.params.owner}/${request.params.repo}`;
      for (const row of integrations.forUser(request.user!.id)) {
        const token = tryDecrypt(row.token_enc, 'git-token');
        if (!token) continue;
        try {
          const branches = await github.branches(token, fullName);
          return {
            branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha })),
          };
        } catch {
          continue;
        }
      }
      throw new HttpError(404, 'Repository not accessible', 'not_found');
    }
  );
}
