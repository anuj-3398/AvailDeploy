import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const buildExecutor = (process.env.BUILD_EXECUTOR ??
  (process.platform === 'win32' ? 'wsl' : 'local')) as 'local' | 'wsl';
const wslDistro = process.env.WSL_DISTRO ?? 'Ubuntu';

/**
 * Where builds actually happen.
 *
 * On Windows the build runs inside WSL, and a workspace on a `/mnt/<drive>`
 * mount crosses the 9p filesystem bridge for every file. `npm install` writes
 * tens of thousands of small files, so that boundary — not the compiler —
 * dominates build time. Putting the workspace on the WSL-native filesystem
 * and reaching it from Windows through `\\wsl.localhost` is several times
 * faster; the SQLite database stays on the Windows disk, where file locking
 * behaves.
 *
 * The probe result is cached in the data directory so it costs one `wsl.exe`
 * call on first boot, not one per process.
 */
function resolveWorkspaceDir(): { dir: string; native: boolean; reason: string } {
  if (process.env.AVAIL_WORKSPACE_DIR) {
    return {
      dir: path.resolve(process.env.AVAIL_WORKSPACE_DIR),
      native: true,
      reason: 'AVAIL_WORKSPACE_DIR',
    };
  }
  if (buildExecutor !== 'wsl' || process.platform !== 'win32') {
    return { dir: dataDir, native: true, reason: 'executor runs on this filesystem' };
  }
  if (!bool(process.env.WSL_NATIVE_WORKSPACE, true)) {
    return { dir: dataDir, native: false, reason: 'disabled by WSL_NATIVE_WORKSPACE' };
  }

  const cacheFile = path.join(dataDir, 'workspace.json');
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      dir: string;
      distro: string;
    };
    if (cached.distro === wslDistro && existsSync(cached.dir)) {
      return { dir: cached.dir, native: true, reason: 'cached WSL-native workspace' };
    }
  } catch {
    /* no usable cache; probe below */
  }

  try {
    const home = spawnSync(
      'wsl.exe',
      ['-d', wslDistro, '--', 'sh', '-lc', 'echo $HOME'],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }
    );
    const wslHome = String(home.stdout ?? '').trim().split('\n').pop() ?? '';
    if (home.status !== 0 || !wslHome.startsWith('/')) {
      return { dir: dataDir, native: false, reason: 'could not read WSL $HOME' };
    }

    const unc = `\\\\wsl.localhost\\${wslDistro}${wslHome.replace(/\//g, '\\')}\\.avail-deploy`;
    mkdirSync(unc, { recursive: true });
    const probe = path.join(unc, '.write-probe');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ dir: unc, distro: wslDistro }, null, 2));
    return { dir: unc, native: true, reason: 'WSL-native workspace' };
  } catch (err) {
    return {
      dir: dataDir,
      native: false,
      reason: `WSL-native workspace unavailable (${(err as Error).message})`,
    };
  }
}

const workspace = resolveWorkspaceDir();

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV ?? 'development',

  // Ports
  apiPort: num(process.env.API_PORT, 3001),
  proxyPort: num(process.env.PROXY_PORT, 3002),
  /** TLS listener for the proxy — a self-signed cert for `*.avail.localhost`,
   * generated on first boot (see `ensureSelfSignedCert` in apps/proxy). Not
   * ACME/publicly-trusted; that needs a real domain we don't have here. */
  proxyHttpsPort: num(process.env.PROXY_HTTPS_PORT, 3443),
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

  // Storage — metadata stays on the host disk, builds go to the workspace.
  dataDir,
  dbFile: process.env.AVAIL_DB_FILE ?? path.join(dataDir, 'avail.db'),
  workspaceDir: workspace.dir,
  workspaceIsNative: workspace.native,
  workspaceReason: workspace.reason,
  /** Persistent per-project checkouts, reused across builds. */
  projectsDir: path.join(workspace.dir, 'projects'),
  /** Immutable per-deployment snapshots. */
  deploymentsDir: path.join(workspace.dir, 'deployments'),
  cacheDir: path.join(workspace.dir, 'cache'),
  /** Self-signed TLS cert/key for the proxy's HTTPS listener. */
  certsDir: path.join(dataDir, 'certs'),

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

  // Google sign-in (identity only — no repository access)
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,
  },

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
    executor: buildExecutor,
    wslDistro,
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
