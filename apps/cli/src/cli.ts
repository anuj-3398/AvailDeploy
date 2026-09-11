#!/usr/bin/env node
/**
 * `avail` — command line client for the Avail Deploy platform.
 *
 *   avail login                 sign in with an allow-listed email address
 *   avail whoami                show the signed-in user
 *   avail projects              list projects
 *   avail deploy [dir] [--prod] deploy a local git repository
 *   avail logs <deploymentId>   stream build logs
 *   avail env add KEY=value     add an environment variable
 *   avail rollback <id>         point production at an existing deployment
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const CONFIG_DIR = path.join(os.homedir(), '.avail');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface CliConfig {
  apiUrl: string;
  token?: string;
  email?: string;
  /** Absolute project directory -> project slug. */
  links?: Record<string, string>;
}

function loadConfig(): CliConfig {
  const defaults: CliConfig = {
    apiUrl: process.env.AVAIL_API_URL ?? 'http://localhost:3001',
    links: {},
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

const color = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

class CliError extends Error {}

async function apiFetch<T>(
  endpoint: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${config.apiUrl}${endpoint}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
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
    if (response.status === 401) {
      throw new CliError('Not signed in. Run `avail login` first.');
    }
    throw new CliError(body?.error?.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

function post<T>(endpoint: string, body: unknown = {}): Promise<T> {
  return apiFetch<T>(endpoint, { method: 'POST', body: JSON.stringify(body) });
}

/* ------------------------------------------------------------- commands */

async function login(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const info = await apiFetch<{ allowedDomains: string[] }>(
      '/api/auth/config'
    );
    console.log(
      color.dim(
        `Sign-in is limited to ${info.allowedDomains.map((d) => `@${d}`).join(', ')}`
      )
    );

    const email = (await rl.question('Email: ')).trim();
    const result = await post<{ delivered: boolean; code?: string }>(
      '/api/auth/login',
      { email }
    );
    if (result.code) {
      console.log(
        color.yellow(`Email delivery is not configured. Your code: ${result.code}`)
      );
    } else {
      console.log(color.dim(`A code was sent to ${email}.`));
    }

    const code = (await rl.question('Code: ')).trim();
    const verified = await post<{ user: { email: string }; token: string }>(
      '/api/auth/verify',
      { email, code, client: 'cli' }
    );

    config = { ...config, token: verified.token, email: verified.user.email };
    saveConfig(config);
    console.log(color.green(`Signed in as ${verified.user.email}`));
  } finally {
    rl.close();
  }
}

async function whoami(): Promise<void> {
  const { user } = await apiFetch<{ user: { email: string; role: string } }>(
    '/api/auth/me'
  );
  console.log(`${user.email} (${user.role})`);
}

async function listProjects(): Promise<void> {
  const { projects } = await apiFetch<{
    projects: {
      name: string;
      slug: string;
      productionUrl: string;
      framework: string | null;
      latestDeployment: { state: string } | null;
    }[];
  }>('/api/projects');

  if (!projects.length) {
    console.log(color.dim('No projects yet. Run `avail deploy` in a repository.'));
    return;
  }
  for (const project of projects) {
    const state = project.latestDeployment?.state ?? 'none';
    console.log(
      `${color.bold(project.name.padEnd(22))} ${String(project.framework ?? 'auto').padEnd(12)} ${stateColor(state)}  ${color.cyan(project.productionUrl)}`
    );
  }
}

function stateColor(state: string): string {
  if (state === 'READY') return color.green(state.padEnd(12));
  if (state === 'ERROR') return color.red(state.padEnd(12));
  return color.yellow(state.padEnd(12));
}

function gitInfo(dir: string): { branch: string; remote: string | null } {
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'main',
    remote: run(['remote', 'get-url', 'origin']),
  };
}

async function deploy(args: string[]): Promise<void> {
  const production = args.includes('--prod') || args.includes('--production');
  const dir = path.resolve(args.find((a) => !a.startsWith('-')) ?? '.');

  if (!existsSync(path.join(dir, '.git'))) {
    throw new CliError(
      `${dir} is not a git repository. The platform deploys from git.`
    );
  }

  const { branch, remote } = gitInfo(dir);
  const linked = config.links?.[dir];

  let slug = linked;
  if (!slug) {
    const name = path.basename(dir);
    console.log(color.dim(`Creating project "${name}"…`));
    const created = await post<{ project: { slug: string } }>('/api/projects', {
      name,
      // A GitHub remote gets full integration; otherwise the local path is
      // cloned directly, which works when the CLI runs beside the platform.
      repoUrl:
        remote && /github\.com/.test(remote)
          ? remote.replace(/\.git$/, '')
          : dir,
      productionBranch: production ? branch : 'main',
      deploy: false,
    });
    slug = created.project.slug;
    config.links = { ...config.links, [dir]: slug };
    saveConfig(config);
  }

  const { deployment } = await post<{
    deployment: { id: string; url: string; target: string };
  }>(`/api/projects/${slug}/deploy`, {
    branch,
    target: production ? 'production' : 'preview',
  });

  console.log(
    `${color.dim('Deploying')} ${slug} ${color.dim(`(${deployment.target}, ${branch})`)}`
  );
  console.log(color.cyan(deployment.url));
  await streamLogs(deployment.id);
}

async function streamLogs(deploymentId: string): Promise<void> {
  let since = -1;
  const terminal = ['READY', 'ERROR', 'CANCELED'];

  for (;;) {
    const { state, logs } = await apiFetch<{
      state: string;
      logs: { seq: number; level: string; text: string }[];
    }>(`/api/deployments/${deploymentId}/logs?since=${since}`);

    for (const line of logs) {
      since = Math.max(since, line.seq);
      const paint =
        line.level === 'error' || line.level === 'stderr'
          ? color.red
          : line.level === 'command'
            ? color.cyan
            : line.level === 'warn'
              ? color.yellow
              : (s: string) => s;
      console.log(paint(line.text));
    }

    if (terminal.includes(state)) {
      const { deployment } = await apiFetch<{
        deployment: { url: string; state: string; error: string | null };
      }>(`/api/deployments/${deploymentId}`);
      if (state === 'READY') {
        console.log(color.green(`\nReady: ${deployment.url}`));
      } else {
        console.log(color.red(`\n${state}: ${deployment.error ?? ''}`));
        process.exitCode = 1;
      }
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function envCommand(args: string[]): Promise<void> {
  const dir = path.resolve('.');
  const slug = config.links?.[dir];
  if (!slug) {
    throw new CliError('This directory is not linked. Run `avail deploy` first.');
  }

  const [action, ...rest] = args;
  if (action === 'ls' || !action) {
    const { env } = await apiFetch<{
      env: { key: string; target: string; preview: string }[];
    }>(`/api/projects/${slug}/env`);
    for (const row of env) {
      console.log(`${row.key.padEnd(28)} ${row.target.padEnd(12)} ${row.preview}`);
    }
    return;
  }

  if (action === 'add') {
    const pair = rest[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq === -1) throw new CliError('Usage: avail env add KEY=value [target]');
    await post(`/api/projects/${slug}/env`, {
      key: pair.slice(0, eq),
      value: pair.slice(eq + 1),
      target: rest[1] ?? 'production',
    });
    console.log(color.green(`Added ${pair.slice(0, eq)}`));
    return;
  }

  throw new CliError(`Unknown env command "${action}"`);
}

async function rollback(deploymentId: string): Promise<void> {
  const result = await post<{ domains: string[] }>(
    `/api/deployments/${deploymentId}/promote`
  );
  console.log(color.green(`Production now serves ${result.domains.join(', ')}`));
}

function usage(): void {
  console.log(`
${color.bold('avail')} — Avail Deploy CLI

  avail login                    Sign in with an allow-listed email address
  avail whoami                   Show the signed-in user
  avail projects                 List projects
  avail deploy [dir] [--prod]    Deploy a local git repository
  avail logs <deploymentId>      Stream build logs
  avail env ls | add KEY=value   Manage environment variables
  avail rollback <deploymentId>  Point production at an existing deployment

Environment:
  AVAIL_API_URL                  Control plane URL (default http://localhost:3001)
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'login':
      return login();
    case 'whoami':
      return whoami();
    case 'projects':
    case 'ls':
      return listProjects();
    case 'deploy':
      return deploy(args);
    case 'logs':
      if (!args[0]) throw new CliError('Usage: avail logs <deploymentId>');
      return streamLogs(args[0]);
    case 'env':
      return envCommand(args);
    case 'rollback':
      if (!args[0]) throw new CliError('Usage: avail rollback <deploymentId>');
      return rollback(args[0]);
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(color.red(err instanceof CliError ? err.message : String(err)));
  process.exit(1);
});
