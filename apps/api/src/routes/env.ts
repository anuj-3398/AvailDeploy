import type { FastifyInstance } from 'fastify';
import { envVars, events } from '@avail/db';
import { encrypt, tryDecrypt } from '@avail/shared/crypto';
import { newEnvId } from '@avail/shared/ids';
import type { EnvTarget } from '@avail/shared/types';
import { HttpError, requireAuth } from '../lib/auth.ts';
import { requireProject } from './projects.ts';

const TARGETS: EnvTarget[] = ['production', 'preview', 'development'];

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Creates or replaces one environment variable. */
export function setEnvVar(
  projectId: string,
  input: { key: string; value: string; target?: string; gitBranch?: string | null },
  userId: string | null
): void {
  const key = input.key?.trim();
  if (!key || !KEY_PATTERN.test(key)) {
    throw new HttpError(
      400,
      `"${input.key}" is not a valid environment variable name`,
      'invalid_key'
    );
  }
  const target = (input.target ?? 'production') as EnvTarget;
  if (!TARGETS.includes(target)) {
    throw new HttpError(400, `Unknown target "${target}"`, 'invalid_target');
  }

  const now = Date.now();
  envVars.upsert({
    id: newEnvId(),
    project_id: projectId,
    key,
    value_enc: encrypt(input.value ?? '', 'env'),
    target,
    git_branch: input.gitBranch?.trim() || null,
    created_at: now,
    updated_at: now,
    created_by: userId,
  });
}

export async function envRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /** Add or update variables; accepts one entry or a batch. */
  app.post<{
    Params: { key: string };
    Body:
      | { key: string; value: string; target?: string; gitBranch?: string }
      | {
          variables: {
            key: string;
            value: string;
            target?: string;
            gitBranch?: string;
          }[];
        };
  }>('/api/projects/:key/env', async (request, reply) => {
    const project = requireProject(request.params.key);
    const body = request.body as any;
    const items = Array.isArray(body?.variables) ? body.variables : [body];

    if (!items.length || !items[0]?.key) {
      throw new HttpError(400, 'No variables supplied', 'invalid_request');
    }
    for (const item of items) {
      setEnvVar(project.id, item, request.user!.id);
    }

    events.record({
      type: 'env.updated',
      project_id: project.id,
      user_id: request.user!.id,
      text: `Updated ${items.length} environment variable(s)`,
    });

    reply.code(201);
    return { ok: true, count: items.length };
  });

  /**
   * Reveals a single decrypted value. Kept as an explicit endpoint so values
   * are never included in list responses.
   */
  app.get<{ Params: { key: string; id: string } }>(
    '/api/projects/:key/env/:id/value',
    async (request) => {
      const project = requireProject(request.params.key);
      const row = envVars.byId(request.params.id);
      if (!row || row.project_id !== project.id) {
        throw new HttpError(404, 'Variable not found', 'not_found');
      }
      return { key: row.key, value: tryDecrypt(row.value_enc, 'env') ?? '' };
    }
  );

  app.delete<{ Params: { key: string; id: string } }>(
    '/api/projects/:key/env/:id',
    async (request) => {
      const project = requireProject(request.params.key);
      const row = envVars.byId(request.params.id);
      if (!row || row.project_id !== project.id) {
        throw new HttpError(404, 'Variable not found', 'not_found');
      }
      envVars.delete(row.id);
      return { ok: true };
    }
  );

  /** Bulk import from a `.env` style payload. */
  app.post<{ Params: { key: string }; Body: { contents?: string; target?: string } }>(
    '/api/projects/:key/env/import',
    async (request) => {
      const project = requireProject(request.params.key);
      const contents = request.body?.contents ?? '';
      const target = request.body?.target ?? 'production';
      let count = 0;

      for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        let value = line.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!KEY_PATTERN.test(key)) continue;
        setEnvVar(project.id, { key, value, target }, request.user!.id);
        count++;
      }

      return { ok: true, count };
    }
  );
}
