import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';

const log = createLogger('github');

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown
  ) {
    super(message);
  }
}

export interface GhUser {
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  default_branch: string;
  updated_at: string;
  pushed_at: string;
  owner: { login: string; avatar_url: string };
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

async function request<T>(
  token: string,
  endpoint: string,
  init: RequestInit = {}
): Promise<T> {
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${config.github.apiUrl}${endpoint}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'avail-deploy',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }

  if (!response.ok) {
    const message =
      (body as { message?: string })?.message ?? `GitHub request failed`;
    throw new GitHubError(
      `${message} (${response.status} ${endpoint})`,
      response.status,
      body
    );
  }
  return body as T;
}

export const github = {
  async user(token: string): Promise<GhUser> {
    return request<GhUser>(token, '/user');
  },

  /** Primary verified email, which is what the domain allow-list checks. */
  async primaryEmail(token: string): Promise<string | null> {
    try {
      const emails = await request<
        { email: string; primary: boolean; verified: boolean }[]
      >(token, '/user/emails');
      const primary = emails.find((e) => e.primary && e.verified);
      return primary?.email ?? emails.find((e) => e.verified)?.email ?? null;
    } catch (err) {
      log.warn('Could not read user emails:', (err as Error).message);
      return null;
    }
  },

  async repos(token: string, page = 1, perPage = 100): Promise<GhRepo[]> {
    return request<GhRepo[]>(
      token,
      `/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
    );
  },

  async repo(token: string, fullName: string): Promise<GhRepo> {
    return request<GhRepo>(token, `/repos/${fullName}`);
  },

  async branches(token: string, fullName: string) {
    return request<{ name: string; commit: { sha: string } }[]>(
      token,
      `/repos/${fullName}/branches?per_page=100`
    );
  },

  /** Latest commit on a branch, or null when the branch does not exist. */
  async branchHead(
    token: string,
    fullName: string,
    branch: string
  ): Promise<{ sha: string; message: string; author: string; url: string } | null> {
    try {
      const data = await request<{
        sha: string;
        html_url: string;
        commit: { message: string; author: { name: string; email: string } };
      }>(token, `/repos/${fullName}/commits/${encodeURIComponent(branch)}`);
      return {
        sha: data.sha,
        message: data.commit.message.split('\n')[0],
        author: `${data.commit.author.name} <${data.commit.author.email}>`,
        url: data.html_url,
      };
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  },

  async createWebhook(
    token: string,
    fullName: string,
    url: string,
    secret: string
  ) {
    return request<{ id: number }>(token, `/repos/${fullName}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push', 'pull_request'],
        config: { url, content_type: 'json', secret, insecure_ssl: '0' },
      }),
    });
  },

  async listWebhooks(token: string, fullName: string) {
    return request<{ id: number; config: { url?: string } }[]>(
      token,
      `/repos/${fullName}/hooks`
    );
  },

  async deleteWebhook(token: string, fullName: string, hookId: number) {
    return request<void>(token, `/repos/${fullName}/hooks/${hookId}`, {
      method: 'DELETE',
    });
  },

  /** Reports deployment status back onto the commit in GitHub. */
  async createCommitStatus(
    token: string,
    fullName: string,
    sha: string,
    status: {
      state: 'pending' | 'success' | 'failure' | 'error';
      target_url?: string;
      description?: string;
      context?: string;
    }
  ) {
    return request(token, `/repos/${fullName}/statuses/${sha}`, {
      method: 'POST',
      body: JSON.stringify({ context: 'avail/deploy', ...status }),
    });
  },

  async commentOnPullRequest(
    token: string,
    fullName: string,
    prNumber: number,
    body: string
  ) {
    return request(token, `/repos/${fullName}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  },

  /** Exchanges an OAuth callback code for an access token. */
  async exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
    if (!config.github.clientId || !config.github.clientSecret) {
      throw new GitHubError('GitHub OAuth is not configured', 500);
    }
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = (await response.json()) as {
      access_token?: string;
      error_description?: string;
    };
    if (!data.access_token) {
      throw new GitHubError(
        data.error_description ?? 'OAuth exchange failed',
        400,
        data
      );
    }
    return data.access_token;
  },

  oauthAuthorizeUrl(redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: config.github.clientId ?? '',
      redirect_uri: redirectUri,
      scope: 'repo read:user user:email admin:repo_hook',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },
};
