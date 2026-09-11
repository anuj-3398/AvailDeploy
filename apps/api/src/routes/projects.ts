import type { FastifyInstance } from 'fastify';
import {
  aliases,
  deployments,
  envVars,
  events,
  integrations,
  projects,
  requestLogs,
} from '@avail/db';
import { config } from '@avail/shared/config';
import { randomSecret, tryDecrypt } from '@avail/shared/crypto';
import { newProjectId, slugify } from '@avail/shared/ids';
import type { Project } from '@avail/shared/types';
import { HttpError, requireAuth } from '../lib/auth.ts';
import { github } from '../lib/github.ts';
import {
  createDeployment,
  productionHost,
  serializeDeployment,
  urlFor,
} from '../services/deployments.ts';
import { poller } from '../services/poller.ts';

export function serializeProject(project: Project) {
  const production = deployments.currentProduction(project.id);
  const latest = deployments.forProject(project.id, 1)[0] ?? null;
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    framework: project.framework,
    rootDirectory: project.root_directory,
    installCommand: project.install_command,
    buildCommand: project.build_command,
    outputDirectory: project.output_directory,
    devCommand: project.dev_command,
    nodeVersion: project.node_version,
    serveMode: project.serve_mode,
    repo: project.repo_full_name
      ? {
          provider: project.repo_provider,
          fullName: project.repo_full_name,
          defaultBranch: project.repo_default_branch,
          url:
            project.repo_provider === 'github'
              ? `https://github.com/${project.repo_full_name}`
              : project.repo_full_name,
        }
      : null,
    productionBranch: project.production_branch,
    autoDeploy: Boolean(project.auto_deploy),
    previewDeploys: Boolean(project.preview_deploys),
    productionUrl: urlFor(productionHost(project.slug)),
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    productionDeployment: production ? serializeDeployment(production) : null,
    latestDeployment: latest ? serializeDeployment(latest) : null,
    deploymentCount: deployments.countForProject(project.id),
  };
}

/** Resolves `:key` (id or slug) or throws a 404. */
export function requireProject(key: string): Project {
  const project = projects.byIdOrSlug(key);
  if (!project) throw new HttpError(404, 'Project not found', 'not_found');
  return project;
}

function uniqueSlug(name: string): string {
  const base = slugify(name);
  if (!projects.slugTaken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!projects.slugTaken(candidate)) return candidate;
  }
  throw new HttpError(409, 'Could not allocate a project name', 'slug_conflict');
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  app.get('/api/projects', async () => ({
    projects: projects.list().map(serializeProject),
  }));

  /**
   * Imports a repository as a project. `repoFullName` uses a connected GitHub
   * account; `repoUrl` accepts any git URL or local path (handy for testing).
   */
  app.post<{
    Body: {
      name?: string;
      repoFullName?: string;
      repoUrl?: string;
      integrationId?: string;
      framework?: string | null;
      rootDirectory?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      outputDirectory?: string | null;
      devCommand?: string | null;
      serveMode?: 'static' | 'server' | null;
      nodeVersion?: string;
      productionBranch?: string;
      autoDeploy?: boolean;
      previewDeploys?: boolean;
      env?: { key: string; value: string; target?: string }[];
      deploy?: boolean;
    };
  }>('/api/projects', async (request, reply) => {
    const body = request.body ?? {};
    const user = request.user!;

    let repoProvider: string | null = null;
    let repoFullName: string | null = null;
    let repoId: string | null = null;
    let defaultBranch: string | null = null;
    let integrationId: string | null = null;

    if (body.repoFullName) {
      const candidates = body.integrationId
        ? [integrations.byId(body.integrationId)].filter(Boolean)
        : integrations.forUser(user.id);
      if (!candidates.length) {
        throw new HttpError(400, 'Connect a GitHub account first', 'no_integration');
      }

      let resolved = null;
      for (const row of candidates) {
        const token = tryDecrypt(row!.token_enc, 'git-token');
        if (!token) continue;
        try {
          const repo = await github.repo(token, body.repoFullName);
          resolved = { repo, integration: row! };
          break;
        } catch {
          continue;
        }
      }
      if (!resolved) {
        throw new HttpError(
          404,
          `Repository ${body.repoFullName} is not accessible with your connected accounts`,
          'repo_not_found'
        );
      }

      repoProvider = 'github';
      repoFullName = resolved.repo.full_name;
      repoId = String(resolved.repo.id);
      defaultBranch = resolved.repo.default_branch;
      integrationId = resolved.integration.id;
    } else if (body.repoUrl) {
      repoProvider = /^https?:\/\/(www\.)?github\.com\//.test(body.repoUrl)
        ? 'github'
        : 'local';
      repoFullName =
        repoProvider === 'github'
          ? body.repoUrl
              .replace(/^https?:\/\/(www\.)?github\.com\//, '')
              .replace(/\.git$/, '')
          : body.repoUrl;
      defaultBranch = body.productionBranch ?? 'main';
    } else {
      throw new HttpError(
        400,
        'Provide either repoFullName (connected GitHub repo) or repoUrl',
        'missing_repo'
      );
    }

    const name =
      body.name?.trim() ||
      (repoFullName ? repoFullName.split('/').pop()! : 'project');
    const now = Date.now();

    const project = projects.create({
      id: newProjectId(),
      name,
      slug: uniqueSlug(name),
      framework: body.framework ?? null,
      root_directory: body.rootDirectory ?? null,
      install_command: body.installCommand ?? null,
      build_command: body.buildCommand ?? null,
      output_directory: body.outputDirectory ?? null,
      dev_command: body.devCommand ?? null,
      node_version: body.nodeVersion ?? config.build.defaultNodeVersion,
      serve_mode: body.serveMode ?? null,
      repo_provider: repoProvider,
      repo_full_name: repoFullName,
      repo_id: repoId,
      repo_default_branch: defaultBranch,
      production_branch: body.productionBranch ?? defaultBranch ?? 'main',
      auto_deploy: body.autoDeploy === false ? 0 : 1,
      preview_deploys: body.previewDeploys === false ? 0 : 1,
      git_integration_id: integrationId,
      webhook_secret: randomSecret(24),
      created_by: user.id,
      created_at: now,
      updated_at: now,
    });

    if (body.env?.length) {
      const { setEnvVar } = await import('./env.ts');
      for (const item of body.env) {
        setEnvVar(project.id, item, user.id);
      }
    }

    events.record({
      type: 'project.created',
      project_id: project.id,
      user_id: user.id,
      text: `Imported ${repoFullName}`,
    });

    // Record current branch heads so the first poll does not deploy them all.
    void poller.seed(project);

    let deployment = null;
    if (body.deploy !== false) {
      deployment = createDeployment({
        project,
        target: 'production',
        source: 'manual',
        branch: project.production_branch,
        createdBy: user.id,
        meta: { trigger: 'import' },
      });
    }

    reply.code(201);
    return {
      project: serializeProject(projects.byId(project.id)!),
      deployment: deployment ? serializeDeployment(deployment) : null,
    };
  });

  app.get<{ Params: { key: string } }>('/api/projects/:key', async (request) => ({
    project: serializeProject(requireProject(request.params.key)),
  }));

  app.patch<{
    Params: { key: string };
    Body: Record<string, unknown>;
  }>('/api/projects/:key', async (request) => {
    const project = requireProject(request.params.key);
    const body = request.body ?? {};

    const FIELD_MAP: Record<string, keyof Project> = {
      name: 'name',
      framework: 'framework',
      rootDirectory: 'root_directory',
      installCommand: 'install_command',
      buildCommand: 'build_command',
      outputDirectory: 'output_directory',
      devCommand: 'dev_command',
      nodeVersion: 'node_version',
      serveMode: 'serve_mode',
      productionBranch: 'production_branch',
    };

    const patch: Partial<Project> = {};
    for (const [apiKey, column] of Object.entries(FIELD_MAP)) {
      if (apiKey in body) {
        const value = body[apiKey];
        (patch as any)[column] =
          value === '' || value === undefined ? null : value;
      }
    }
    if ('autoDeploy' in body) patch.auto_deploy = body.autoDeploy ? 1 : 0;
    if ('previewDeploys' in body) patch.preview_deploys = body.previewDeploys ? 1 : 0;

    projects.update(project.id, patch);
    return { project: serializeProject(projects.byId(project.id)!) };
  });

  app.delete<{ Params: { key: string } }>(
    '/api/projects/:key',
    async (request) => {
      const project = requireProject(request.params.key);
      const { removeDeploymentDir } = await import('@avail/builder');
      for (const deployment of deployments.forProject(project.id, 1000)) {
        try {
          removeDeploymentDir(deployment.id);
        } catch {
          /* already gone */
        }
      }
      projects.delete(project.id);
      events.record({
        type: 'project.deleted',
        user_id: request.user!.id,
        text: `Deleted project ${project.name}`,
      });
      return { ok: true };
    }
  );

  /** Manually trigger a deployment (the dashboard's Redeploy / Deploy button). */
  app.post<{
    Params: { key: string };
    Body: { branch?: string; target?: 'production' | 'preview'; sha?: string };
  }>('/api/projects/:key/deploy', async (request, reply) => {
    const project = requireProject(request.params.key);
    const branch = request.body?.branch || project.production_branch;
    const target =
      request.body?.target ??
      (branch === project.production_branch ? 'production' : 'preview');

    let commit: { sha: string; message: string; author: string; url: string } | null =
      null;
    if (project.repo_provider === 'github' && !request.body?.sha) {
      const { gitTokenFor } = await import('../services/deployments.ts');
      const token = gitTokenFor(project);
      if (token && project.repo_full_name) {
        commit = await github
          .branchHead(token, project.repo_full_name, branch)
          .catch(() => null);
      }
    }

    const deployment = createDeployment({
      project,
      target,
      source: 'manual',
      branch,
      commitSha: request.body?.sha ?? commit?.sha ?? null,
      commitMessage: commit?.message ?? null,
      commitAuthor: commit?.author ?? null,
      commitUrl: commit?.url ?? null,
      createdBy: request.user!.id,
      meta: { trigger: 'manual' },
    });

    reply.code(202);
    return { deployment: serializeDeployment(deployment) };
  });

  app.get<{
    Params: { key: string };
    Querystring: { limit?: string; offset?: string; target?: string };
  }>('/api/projects/:key/deployments', async (request) => {
    const project = requireProject(request.params.key);
    const limit = Math.min(Number(request.query.limit ?? 30) || 30, 100);
    const offset = Number(request.query.offset ?? 0) || 0;
    const rows = deployments
      .forProject(project.id, limit, offset)
      .filter((d) => !request.query.target || d.target === request.query.target);
    return { deployments: rows.map(serializeDeployment) };
  });

  /* ---------------------------------------------------------- access logs */

  /**
   * Requests served by the proxy for this project.
   *
   * The proxy writes these from its own process, so the dashboard tails them
   * by passing back the highest id it has seen rather than by subscribing to
   * an in-process event bus.
   */
  app.get<{
    Params: { key: string };
    Querystring: {
      limit?: string;
      sinceId?: string;
      q?: string;
      status?: string;
      deploymentId?: string;
    };
  }>('/api/projects/:key/logs', async (request) => {
    const project = requireProject(request.params.key);
    const sinceRaw = Number(request.query.sinceId);

    const rows = requestLogs.forProject(project.id, {
      limit: Math.min(Number(request.query.limit ?? 100) || 100, 500),
      sinceId: Number.isFinite(sinceRaw) && sinceRaw >= 0 ? sinceRaw : undefined,
      search: request.query.q?.trim() || undefined,
      status: request.query.status === 'error' ? 'error' : 'all',
      deploymentId: request.query.deploymentId || null,
    });

    return {
      logs: rows.map((row) => ({
        id: row.id,
        ts: row.ts,
        method: row.method,
        host: row.host,
        path: row.path,
        status: row.status,
        durationMs: row.duration_ms,
        kind: row.kind,
        message: row.message,
        deploymentId: row.deployment_id,
      })),
      total: requestLogs.countForProject(project.id),
    };
  });

  /* ------------------------------------------------------------ webhooks */

  /** Webhook endpoint + secret, for wiring up a repository by hand. */
  app.get<{ Params: { key: string } }>(
    '/api/projects/:key/webhook',
    async (request) => {
      const project = requireProject(request.params.key);
      let secret = project.webhook_secret;
      if (!secret) {
        secret = randomSecret(24);
        projects.update(project.id, { webhook_secret: secret });
      }
      return {
        url: `${config.apiUrl}/api/webhooks/github`,
        secret,
        contentType: 'application/json',
        events: ['push', 'pull_request'],
      };
    }
  );

  /** Registers a GitHub webhook so pushes deploy without polling. */
  app.post<{ Params: { key: string }; Body: { url?: string } }>(
    '/api/projects/:key/webhook',
    async (request) => {
      const project = requireProject(request.params.key);
      if (project.repo_provider !== 'github' || !project.repo_full_name) {
        throw new HttpError(400, 'Project is not connected to GitHub', 'not_github');
      }
      const { gitTokenFor } = await import('../services/deployments.ts');
      const token = gitTokenFor(project);
      if (!token) throw new HttpError(400, 'No GitHub token available', 'no_integration');

      const url = request.body?.url || `${config.apiUrl}/api/webhooks/github`;
      const secret = project.webhook_secret ?? randomSecret(24);
      if (!project.webhook_secret) {
        projects.update(project.id, { webhook_secret: secret });
      }

      const existing = await github
        .listWebhooks(token, project.repo_full_name)
        .catch(() => []);
      for (const hook of existing) {
        if (hook.config?.url === url) {
          await github
            .deleteWebhook(token, project.repo_full_name, hook.id)
            .catch(() => {});
        }
      }

      const created = await github.createWebhook(
        token,
        project.repo_full_name,
        url,
        secret
      );
      return { ok: true, hookId: created.id, url };
    }
  );

  /* ------------------------------------------------------------- domains */

  app.get<{ Params: { key: string } }>(
    '/api/projects/:key/domains',
    async (request) => {
      const project = requireProject(request.params.key);
      return {
        domains: aliases.forProject(project.id).map((alias) => ({
          id: alias.id,
          domain: alias.domain,
          url: urlFor(alias.domain),
          type: alias.type,
          deploymentId: alias.deployment_id,
          updatedAt: alias.updated_at,
        })),
      };
    }
  );

  app.post<{
    Params: { key: string };
    Body: { domain?: string; deploymentId?: string };
  }>('/api/projects/:key/domains', async (request) => {
    const project = requireProject(request.params.key);
    const domain = request.body?.domain?.trim().toLowerCase();
    if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
      throw new HttpError(400, 'A valid domain is required', 'invalid_domain');
    }

    const existing = aliases.byDomain(domain);
    if (existing && existing.project_id !== project.id) {
      throw new HttpError(409, 'Domain is already assigned', 'domain_taken');
    }

    const target =
      request.body?.deploymentId ??
      deployments.currentProduction(project.id)?.id ??
      null;

    const { newAliasId } = await import('@avail/shared/ids');
    const now = Date.now();
    aliases.upsert({
      id: existing?.id ?? newAliasId(),
      domain,
      project_id: project.id,
      deployment_id: target,
      type: 'custom',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    return { domain, url: urlFor(domain), deploymentId: target };
  });

  app.delete<{ Params: { key: string; domain: string } }>(
    '/api/projects/:key/domains/:domain',
    async (request) => {
      const project = requireProject(request.params.key);
      const alias = aliases.byDomain(request.params.domain);
      if (!alias || alias.project_id !== project.id) {
        throw new HttpError(404, 'Domain not found', 'not_found');
      }
      if (alias.type !== 'custom') {
        throw new HttpError(
          400,
          'System domains cannot be removed',
          'system_domain'
        );
      }
      aliases.delete(alias.id);
      return { ok: true };
    }
  );

  /* ---------------------------------------------------------------- env */

  app.get<{ Params: { key: string } }>('/api/projects/:key/env', async (request) => {
    const project = requireProject(request.params.key);
    return {
      env: envVars.forProject(project.id).map((row) => ({
        id: row.id,
        key: row.key,
        target: row.target,
        gitBranch: row.git_branch,
        updatedAt: row.updated_at,
        // Values are never returned in full; the dashboard shows a preview.
        preview: maskValue(tryDecrypt(row.value_enc, 'env')),
      })),
    };
  });
}

function maskValue(value: string | null): string {
  if (!value) return '••••••••';
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(value.length - 2, 12))}`;
}
