/** Thin fetch wrapper around the control-plane API. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error'
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.message ?? `Request failed (${response.status})`,
      body?.error?.code ?? 'error'
    );
  }
  return body as T;
}

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export interface User {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
}

export interface Integration {
  id: string;
  provider: string;
  kind: string;
  login: string;
  avatarUrl: string | null;
  createdAt: number;
}

export type DeploymentState =
  | 'QUEUED'
  | 'INITIALIZING'
  | 'BUILDING'
  | 'UPLOADING'
  | 'READY'
  | 'ERROR'
  | 'CANCELED';

export interface Deployment {
  id: string;
  projectId: string;
  projectSlug: string | null;
  projectName: string | null;
  state: DeploymentState;
  target: 'production' | 'preview';
  source: string;
  branch: string | null;
  commit: {
    sha: string;
    shortSha: string;
    message: string | null;
    author: string | null;
    url: string | null;
  } | null;
  prNumber: number | null;
  url: string;
  host: string;
  aliases: { domain: string; url: string; type: string }[];
  framework: string | null;
  serveMode: string | null;
  error: string | null;
  isCurrentProduction: boolean;
  createdAt: number;
  buildingAt: number | null;
  readyAt: number | null;
  buildDurationMs: number | null;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  framework: string | null;
  rootDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  devCommand: string | null;
  nodeVersion: string;
  serveMode: string | null;
  repo: {
    provider: string | null;
    fullName: string;
    defaultBranch: string | null;
    url: string;
  } | null;
  productionBranch: string;
  autoDeploy: boolean;
  previewDeploys: boolean;
  productionUrl: string;
  createdAt: number;
  updatedAt: number;
  productionDeployment: Deployment | null;
  latestDeployment: Deployment | null;
  deploymentCount: number;
}

export interface Repo {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  url: string;
  pushedAt: string;
  owner: string;
  ownerAvatar: string;
  integrationId: string;
}

export interface EnvVarRow {
  id: string;
  key: string;
  target: string;
  gitBranch: string | null;
  updatedAt: number;
  preview: string;
}

export interface LogLine {
  seq: number;
  ts: number;
  level: string;
  text: string;
}

export const api = {
  /* auth */
  authConfig: () =>
    request<{
      allowedDomains: string[];
      githubSignIn: boolean;
      googleSignIn: boolean;
      devEcho: boolean;
      mailDelivery: string;
    }>('/api/auth/config'),
  requestCode: (email: string, intent: 'login' | 'signup' = 'login') =>
    request<{ ok: boolean; delivered: boolean; intent: string; code?: string }>(
      '/api/auth/login',
      { method: 'POST', ...json({ email, intent }) }
    ),
  verifyCode: (email: string, code: string) =>
    request<{ user: User }>('/api/auth/verify', {
      method: 'POST',
      ...json({ email, code }),
    }),
  me: () =>
    request<{ user: User; integrations: Integration[] }>('/api/auth/me'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  /* system */
  systemInfo: () =>
    request<{
      name: string;
      allowedDomains: string[];
      deploymentDomain: string;
      buildExecutor: string;
      githubOAuth: boolean;
      webhookUrl: string;
    }>('/api/system/info'),
  systemStatus: () => request<any>('/api/system/status'),
  frameworks: () =>
    request<{
      frameworks: {
        slug: string;
        name: string;
        buildCommand: string | null;
        installCommand: string | null;
        outputDirectory: string | null;
      }[];
    }>('/api/frameworks'),
  poll: () => request<{ checked: number; triggered: number }>('/api/system/poll', {
    method: 'POST',
  }),

  /* git */
  integrations: () =>
    request<{ integrations: Integration[] }>('/api/git/integrations'),
  connectToken: (token: string) =>
    request<{ integration: Integration }>('/api/git/integrations', {
      method: 'POST',
      ...json({ token }),
    }),
  disconnect: (id: string) =>
    request<{ ok: boolean }>(`/api/git/integrations/${id}`, { method: 'DELETE' }),
  repos: (q?: string) =>
    request<{ repos: Repo[] }>(
      `/api/git/repos${q ? `?q=${encodeURIComponent(q)}` : ''}`
    ),

  /* projects */
  projects: () => request<{ projects: Project[] }>('/api/projects'),
  project: (key: string) =>
    request<{ project: Project }>(`/api/projects/${key}`),
  createProject: (body: Record<string, unknown>) =>
    request<{ project: Project; deployment: Deployment | null }>(
      '/api/projects',
      { method: 'POST', ...json(body) }
    ),
  updateProject: (key: string, body: Record<string, unknown>) =>
    request<{ project: Project }>(`/api/projects/${key}`, {
      method: 'PATCH',
      ...json(body),
    }),
  deleteProject: (key: string) =>
    request<{ ok: boolean }>(`/api/projects/${key}`, { method: 'DELETE' }),
  deploy: (key: string, body: Record<string, unknown> = {}) =>
    request<{ deployment: Deployment }>(`/api/projects/${key}/deploy`, {
      method: 'POST',
      ...json(body),
    }),
  projectDeployments: (key: string, limit = 30) =>
    request<{ deployments: Deployment[] }>(
      `/api/projects/${key}/deployments?limit=${limit}`
    ),
  domains: (key: string) =>
    request<{
      domains: {
        id: string;
        domain: string;
        url: string;
        type: string;
        deploymentId: string | null;
        updatedAt: number;
      }[];
    }>(`/api/projects/${key}/domains`),
  addDomain: (key: string, domain: string) =>
    request(`/api/projects/${key}/domains`, {
      method: 'POST',
      ...json({ domain }),
    }),
  removeDomain: (key: string, domain: string) =>
    request(`/api/projects/${key}/domains/${domain}`, { method: 'DELETE' }),
  webhookInfo: (key: string) =>
    request<{ url: string; secret: string; events: string[] }>(
      `/api/projects/${key}/webhook`
    ),
  registerWebhook: (key: string) =>
    request<{ ok: boolean; hookId: number; url: string }>(
      `/api/projects/${key}/webhook`,
      { method: 'POST', ...json({}) }
    ),

  /* env */
  env: (key: string) => request<{ env: EnvVarRow[] }>(`/api/projects/${key}/env`),
  setEnv: (
    key: string,
    variable: { key: string; value: string; target: string; gitBranch?: string }
  ) =>
    request<{ ok: boolean }>(`/api/projects/${key}/env`, {
      method: 'POST',
      ...json(variable),
    }),
  revealEnv: (key: string, id: string) =>
    request<{ key: string; value: string }>(
      `/api/projects/${key}/env/${id}/value`
    ),
  deleteEnv: (key: string, id: string) =>
    request<{ ok: boolean }>(`/api/projects/${key}/env/${id}`, {
      method: 'DELETE',
    }),
  importEnv: (key: string, contents: string, target: string) =>
    request<{ count: number }>(`/api/projects/${key}/env/import`, {
      method: 'POST',
      ...json({ contents, target }),
    }),

  /* deployments */
  deployments: (limit = 25) =>
    request<{ deployments: Deployment[] }>(`/api/deployments?limit=${limit}`),
  deployment: (id: string) =>
    request<{ deployment: Deployment; isBuilding: boolean }>(
      `/api/deployments/${id}`
    ),
  logs: (id: string, since = -1) =>
    request<{ state: DeploymentState; logs: LogLine[] }>(
      `/api/deployments/${id}/logs?since=${since}`
    ),
  cancel: (id: string) =>
    request<{ ok: boolean }>(`/api/deployments/${id}/cancel`, { method: 'POST' }),
  promote: (id: string) =>
    request<{ ok: boolean; domains: string[] }>(
      `/api/deployments/${id}/promote`,
      { method: 'POST' }
    ),
  redeploy: (id: string, target?: string) =>
    request<{ deployment: Deployment }>(`/api/deployments/${id}/redeploy`, {
      method: 'POST',
      ...json(target ? { target } : {}),
    }),
  deleteDeployment: (id: string) =>
    request<{ ok: boolean }>(`/api/deployments/${id}`, { method: 'DELETE' }),
};
