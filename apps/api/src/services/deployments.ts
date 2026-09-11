import { aliases, deployments, envVars, events, integrations, projects } from '@avail/db';
import { config } from '@avail/shared/config';
import { tryDecrypt } from '@avail/shared/crypto';
import { newAliasId, newDeploymentId, shortHash, slugify } from '@avail/shared/ids';
import type {
  Deployment,
  DeploymentSource,
  DeploymentTarget,
  EnvTarget,
  Project,
} from '@avail/shared/types';
import { bus } from '../lib/bus.ts';
import { queue } from './queue.ts';

/** `http://my-app-a1b2c3.avail.localhost:3002` */
export function urlFor(host: string): string {
  const port = config.proxyPort === 80 ? '' : `:${config.proxyPort}`;
  return `${config.deploymentScheme}://${host}${port}`;
}

export function deploymentHost(projectSlug: string, suffix = shortHash(7)): string {
  return `${projectSlug}-${suffix}.${config.deploymentDomain}`;
}

export function productionHost(projectSlug: string): string {
  return `${projectSlug}.${config.deploymentDomain}`;
}

export function branchHost(projectSlug: string, branch: string): string {
  return `${projectSlug}-git-${slugify(branch)}.${config.deploymentDomain}`;
}

function upsertAlias(
  domain: string,
  projectId: string,
  deploymentId: string | null,
  type: 'production' | 'branch' | 'deployment' | 'custom'
) {
  const now = Date.now();
  return aliases.upsert({
    id: newAliasId(),
    domain,
    project_id: projectId,
    deployment_id: deploymentId,
    type,
    created_at: now,
    updated_at: now,
  });
}

export interface CreateDeploymentInput {
  project: Project;
  target: DeploymentTarget;
  source: DeploymentSource;
  branch?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  commitUrl?: string | null;
  prNumber?: number | null;
  createdBy?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Registers a deployment in QUEUED state, reserves its immutable hostname and
 * hands it to the build queue.
 */
export function createDeployment(input: CreateDeploymentInput): Deployment {
  const { project } = input;
  const id = newDeploymentId();
  const host = deploymentHost(project.slug);
  const branch = input.branch ?? project.production_branch;

  const deployment = deployments.create({
    id,
    project_id: project.id,
    state: 'QUEUED',
    target: input.target,
    source: input.source,
    branch,
    commit_sha: input.commitSha ?? null,
    commit_message: input.commitMessage ?? null,
    commit_author: input.commitAuthor ?? null,
    commit_url: input.commitUrl ?? null,
    pr_number: input.prNumber ?? null,
    url: host,
    framework: project.framework,
    serve_mode: null,
    start_command: null,
    output_path: null,
    error: null,
    created_by: input.createdBy ?? null,
    created_at: Date.now(),
    building_at: null,
    ready_at: null,
    build_duration_ms: null,
    is_current_production: 0,
    meta: input.meta ? JSON.stringify(input.meta) : null,
  });

  upsertAlias(host, project.id, id, 'deployment');

  events.record({
    type: 'deployment.created',
    project_id: project.id,
    deployment_id: id,
    user_id: input.createdBy ?? null,
    text: `${input.target === 'production' ? 'Production' : 'Preview'} deployment queued for ${branch}`,
  });

  bus.publishDeployment({
    deploymentId: id,
    projectId: project.id,
    state: 'QUEUED',
    deployment,
  });

  queue.enqueue(id);
  return deployment;
}

/**
 * Points the branch alias (and, for production deployments, the project's
 * production domain) at a finished deployment.
 */
export function assignAliases(deployment: Deployment, project: Project): string[] {
  const assigned: string[] = [deployment.url];

  if (deployment.branch) {
    const host = branchHost(project.slug, deployment.branch);
    upsertAlias(host, project.id, deployment.id, 'branch');
    assigned.push(host);
  }

  if (deployment.target === 'production') {
    const host = productionHost(project.slug);
    upsertAlias(host, project.id, deployment.id, 'production');
    deployments.promote(project.id, deployment.id);
    assigned.push(host);
  }

  return assigned;
}

/** Points the production domain at an existing READY deployment. */
export function promoteToProduction(
  deployment: Deployment,
  project: Project,
  userId?: string | null
): string[] {
  if (deployment.state !== 'READY') {
    throw new Error('Only READY deployments can be promoted');
  }
  const host = productionHost(project.slug);
  upsertAlias(host, project.id, deployment.id, 'production');
  deployments.promote(project.id, deployment.id);
  deployments.update(deployment.id, { target: 'production' });

  events.record({
    type: 'deployment.promoted',
    project_id: project.id,
    deployment_id: deployment.id,
    user_id: userId ?? null,
    text: `Promoted ${deployment.id} to production`,
  });

  const updated = deployments.byId(deployment.id)!;
  bus.publishDeployment({
    deploymentId: deployment.id,
    projectId: project.id,
    state: updated.state,
    deployment: updated,
  });

  return [host, deployment.url];
}

/** Decrypted environment variables that apply to a deployment. */
export function envForDeployment(
  projectId: string,
  target: DeploymentTarget,
  branch: string | null
): Record<string, string> {
  const rows = envVars.forBuild(projectId, target as EnvTarget, branch);
  const env: Record<string, string> = {};
  // Branch-specific values are ordered last so they overwrite the defaults.
  for (const row of [...rows].reverse()) {
    const value = tryDecrypt(row.value_enc, 'env');
    if (value !== null) env[row.key] = value;
  }
  return env;
}

/** Git access token for a project, falling back to any workspace token. */
export function gitTokenFor(project: Project): string | null {
  const integration = project.git_integration_id
    ? integrations.byId(project.git_integration_id)
    : integrations.any();
  if (!integration) return null;
  return tryDecrypt(integration.token_enc, 'git-token');
}

/** Public JSON shape returned by the API for a deployment. */
export function serializeDeployment(deployment: Deployment) {
  const project = projects.byId(deployment.project_id);
  return {
    id: deployment.id,
    projectId: deployment.project_id,
    projectSlug: project?.slug ?? null,
    projectName: project?.name ?? null,
    state: deployment.state,
    target: deployment.target,
    source: deployment.source,
    branch: deployment.branch,
    commit: deployment.commit_sha
      ? {
          sha: deployment.commit_sha,
          shortSha: deployment.commit_sha.slice(0, 7),
          message: deployment.commit_message,
          author: deployment.commit_author,
          url: deployment.commit_url,
        }
      : null,
    prNumber: deployment.pr_number,
    url: urlFor(deployment.url),
    host: deployment.url,
    aliases: aliases
      .forDeployment(deployment.id)
      .map((a) => ({ domain: a.domain, url: urlFor(a.domain), type: a.type })),
    framework: deployment.framework,
    serveMode: deployment.serve_mode,
    error: deployment.error,
    isCurrentProduction: Boolean(deployment.is_current_production),
    createdAt: deployment.created_at,
    buildingAt: deployment.building_at,
    readyAt: deployment.ready_at,
    buildDurationMs: deployment.build_duration_ms,
    createdBy: deployment.created_by,
  };
}
