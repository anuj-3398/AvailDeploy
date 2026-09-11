import type { FastifyInstance, FastifyRequest } from 'fastify';
import { projects, repoWatch, webhookDeliveries } from '@avail/db';
import { config } from '@avail/shared/config';
import { verifyGithubSignature } from '@avail/shared/crypto';
import { id } from '@avail/shared/ids';
import { createLogger } from '@avail/shared/logger';
import type { Project } from '@avail/shared/types';
import { HttpError } from '../lib/auth.ts';
import { createDeployment, serializeDeployment } from '../services/deployments.ts';

const log = createLogger('webhook');

interface PushPayload {
  ref: string;
  deleted?: boolean;
  after?: string;
  repository: { full_name: string; default_branch: string };
  head_commit?: {
    id: string;
    message: string;
    url: string;
    author: { name: string; email: string };
  } | null;
  pusher?: { name: string };
}

interface PullRequestPayload {
  action: string;
  number: number;
  repository: { full_name: string };
  pull_request: {
    number: number;
    head: { ref: string; sha: string };
    base: { ref: string };
    title: string;
    user: { login: string };
    html_url: string;
    draft?: boolean;
  };
}

/** Projects connected to `fullName` whose signature matches the payload. */
function matchingProjects(
  fullName: string,
  raw: Buffer,
  signature: string | undefined
): Project[] {
  const candidates = projects.byRepo(fullName);
  if (!candidates.length) return [];

  return candidates.filter((project) => {
    const secret = project.webhook_secret ?? config.github.webhookSecret;
    // Without a configured secret we accept the delivery but log it as unsigned.
    if (!secret) return true;
    return verifyGithubSignature(raw, signature, secret);
  });
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Webhook signatures are computed over the exact bytes GitHub sent.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString('utf8') || '{}'));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  app.post('/api/webhooks/github', async (request, reply) => {
    const event = String(request.headers['x-github-event'] ?? '');
    const delivery = String(request.headers['x-github-delivery'] ?? '') || null;
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    const raw =
      (request as FastifyRequest & { rawBody?: Buffer }).rawBody ??
      Buffer.from(JSON.stringify(request.body ?? {}));

    if (event === 'ping') {
      return { ok: true, pong: true };
    }

    const payload = request.body as PushPayload | PullRequestPayload;
    const fullName = payload?.repository?.full_name;
    if (!fullName) {
      throw new HttpError(400, 'Unsupported webhook payload', 'invalid_payload');
    }

    const matched = matchingProjects(fullName, raw, signature);
    if (!matched.length) {
      const known = projects.byRepo(fullName).length;
      const result = known
        ? 'signature_mismatch'
        : 'no_project_connected';
      webhookDeliveries.record({
        id: id('whk'),
        project_id: null,
        event,
        delivery_id: delivery,
        payload: null,
        result,
      });
      log.warn(`Ignored ${event} for ${fullName}: ${result}`);
      reply.code(known ? 401 : 202);
      return { ok: false, reason: result };
    }

    const created: string[] = [];

    for (const project of matched) {
      try {
        if (event === 'push') {
          created.push(...handlePush(project, payload as PushPayload));
        } else if (event === 'pull_request') {
          created.push(
            ...handlePullRequest(project, payload as PullRequestPayload)
          );
        }
        webhookDeliveries.record({
          id: id('whk'),
          project_id: project.id,
          event,
          delivery_id: delivery,
          payload: null,
          result: created.length ? 'deployed' : 'ignored',
        });
      } catch (err) {
        log.error(`Webhook handling failed for ${project.slug}:`, err);
        webhookDeliveries.record({
          id: id('whk'),
          project_id: project.id,
          event,
          delivery_id: delivery,
          payload: null,
          result: `error: ${(err as Error).message}`,
        });
      }
    }

    return { ok: true, event, deployments: created };
  });

  /** Webhook delivery history, for debugging integrations. */
  app.get('/api/webhooks/deliveries', async () => ({
    deliveries: webhookDeliveries.recent(50),
  }));
}

function handlePush(project: Project, payload: PushPayload): string[] {
  if (!project.auto_deploy) return [];
  if (payload.deleted) return [];
  if (!payload.ref?.startsWith('refs/heads/')) return [];

  const branch = payload.ref.slice('refs/heads/'.length);
  const isProduction = branch === project.production_branch;
  if (!isProduction && !project.preview_deploys) return [];

  const commit = payload.head_commit;
  const sha = commit?.id ?? payload.after ?? null;
  if (sha) repoWatch.set(project.id, branch, sha);

  const deployment = createDeployment({
    project,
    target: isProduction ? 'production' : 'preview',
    source: 'git',
    branch,
    commitSha: sha,
    commitMessage: commit?.message?.split('\n')[0] ?? null,
    commitAuthor: commit
      ? `${commit.author.name} <${commit.author.email}>`
      : (payload.pusher?.name ?? null),
    commitUrl: commit?.url ?? null,
    meta: { trigger: 'webhook:push' },
  });

  log.info(
    `Push to ${project.repo_full_name}@${branch} -> ${deployment.id} (${deployment.target})`
  );
  return [deployment.id];
}

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

function handlePullRequest(
  project: Project,
  payload: PullRequestPayload
): string[] {
  if (!project.auto_deploy || !project.preview_deploys) return [];
  if (!PR_ACTIONS.has(payload.action)) return [];

  const pr = payload.pull_request;
  if (pr.draft && payload.action !== 'ready_for_review') return [];

  const deployment = createDeployment({
    project,
    target: 'preview',
    source: 'git',
    branch: pr.head.ref,
    commitSha: pr.head.sha,
    commitMessage: pr.title,
    commitAuthor: pr.user.login,
    commitUrl: pr.html_url,
    prNumber: pr.number,
    meta: { trigger: `webhook:pull_request:${payload.action}` },
  });

  repoWatch.set(project.id, pr.head.ref, pr.head.sha);
  log.info(
    `PR #${pr.number} on ${project.repo_full_name} -> preview ${deployment.id}`
  );
  return [deployment.id];
}
