import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root — three levels up from packages/shared/src. */
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);

/** Minimal .env loader so the platform has no dotenv dependency. */
function loadEnvFile(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, '.env.local'));

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : fallback;
};
const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);

/**
 * Build workspaces must live OUTSIDE the platform repository. Node and npm
 * resolve modules by walking up the directory tree, so a build nested under
 * the repo would inherit the platform's own `node_modules` and workspace
 * configuration instead of installing its own dependencies.
 */
const dataDir = process.env.AVAIL_DATA_DIR
  ? path.resolve(process.env.AVAIL_DATA_DIR)
  : path.join(os.homedir(), '.avail-deploy');

/** True when the data directory is nested inside the platform repository. */
export function dataDirIsNested(): boolean {
  const relative = path.relative(ROOT, dataDir);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV ?? 'development',

  // Ports
  apiPort: num(process.env.API_PORT, 3001),
  proxyPort: num(process.env.PROXY_PORT, 3002),
  dashboardPort: num(process.env.DASHBOARD_PORT, 3000),
  host: process.env.HOST ?? '127.0.0.1',

  // Public URLs
  apiUrl: process.env.API_URL ?? `http://localhost:${num(process.env.API_PORT, 3001)}`,
  dashboardUrl:
    process.env.DASHBOARD_URL ??
    `http://localhost:${num(process.env.DASHBOARD_PORT, 3000)}`,

  /**
   * Wildcard base domain for deployment hostnames. `*.localhost` resolves to
   * 127.0.0.1 in every modern browser, so previews work with no DNS setup.
   */
  deploymentDomain: process.env.DEPLOYMENT_DOMAIN ?? 'avail.localhost',
  deploymentScheme: process.env.DEPLOYMENT_SCHEME ?? 'http',

  // Storage
  dataDir,
  dbFile: process.env.AVAIL_DB_FILE ?? path.join(dataDir, 'avail.db'),
  buildsDir: path.join(dataDir, 'builds'),
  deploymentsDir: path.join(dataDir, 'deployments'),
  reposDir: path.join(dataDir, 'repos'),
  cacheDir: path.join(dataDir, 'cache'),

  // Auth
  secret: process.env.AVAIL_SECRET ?? 'dev-insecure-secret-change-me',
  allowedEmailDomains: (process.env.ALLOWED_EMAIL_DOMAINS ?? 'availproject.org')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  sessionTtlMs: num(process.env.SESSION_TTL_DAYS, 30) * 24 * 60 * 60 * 1000,
  loginCodeTtlMs: num(process.env.LOGIN_CODE_TTL_MINUTES, 10) * 60 * 1000,
  /** Return the login code in the API response (local development only). */
  authDevEcho: bool(process.env.AUTH_DEV_ECHO, true),
  cookieName: process.env.COOKIE_NAME ?? 'avail_session',

  // Mail
  smtpUrl: process.env.SMTP_URL ?? null,
  mailFrom: process.env.MAIL_FROM ?? 'Avail Deploy <deploy@availproject.org>',

  // GitHub
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? null,
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? null,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
    apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
    /** Poll connected repos when no public webhook URL is reachable. */
    pollEnabled: bool(process.env.GITHUB_POLL_ENABLED, true),
    pollIntervalMs: num(process.env.GITHUB_POLL_INTERVAL_SECONDS, 60) * 1000,
  },

  // Builds
  build: {
    /** `local` runs commands with the host shell, `wsl` runs them inside WSL. */
    executor: (process.env.BUILD_EXECUTOR ??
      (process.platform === 'win32' ? 'wsl' : 'local')) as 'local' | 'wsl',
    wslDistro: process.env.WSL_DISTRO ?? 'Ubuntu',
    concurrency: num(process.env.BUILD_CONCURRENCY, 2),
    timeoutMs: num(process.env.BUILD_TIMEOUT_MINUTES, 30) * 60 * 1000,
    /** Keep this many finished deployments per project on disk. */
    keepPerProject: num(process.env.KEEP_DEPLOYMENTS_PER_PROJECT, 20),
    defaultNodeVersion: process.env.DEFAULT_NODE_VERSION ?? '22.x',
  },

  // Runtime (serverless functions + server deployments)
  runtime: {
    idleTimeoutMs: num(process.env.RUNTIME_IDLE_MINUTES, 15) * 60 * 1000,
    bootTimeoutMs: num(process.env.RUNTIME_BOOT_TIMEOUT_SECONDS, 90) * 1000,
    portRangeStart: num(process.env.RUNTIME_PORT_START, 43000),
    portRangeEnd: num(process.env.RUNTIME_PORT_END, 44000),
    maxDurationSec: num(process.env.FUNCTION_MAX_DURATION, 60),
  },
} as const;

export type Config = typeof config;

/** True when `email` belongs to an allow-listed domain. */
export function isEmailAllowed(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return config.allowedEmailDomains.includes(domain);
}

/** Normalizes user input into a comparable email address. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
