#!/usr/bin/env node
/**
 * Starts the whole platform: avail-api + avail-worker (rust-api/, built on
 * demand) as the control-plane API and build runner, plus apps/proxy and
 * the dashboard, with interleaved, prefixed output. Node is only apps/proxy
 * and the dashboard now — apps/api and apps/worker were removed once
 * rust-api's avail-api/avail-worker fully replaced them. See
 * docs/rust-api-migration-plan.md.
 *
 *   npm run dev              all four, dashboard in Vite dev mode
 *   npm run start            all four, release build, dashboard pre-built
 *   node scripts/dev.mjs --only api,worker
 *   node scripts/dev.mjs --skip-build   (reuse already-built Rust binaries)
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST_DIR = path.join(ROOT, 'rust-api');
const WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const skipBuild = args.includes('--skip-build');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1])
      .split(',')
      .map((s) => s.trim())
  : null;

// This host has no MSVC linker — the GNU toolchain is what actually links.
// A no-op prefix on every other platform. See "Build note" in the plan doc.
const CARGO = WIN ? 'rustup' : 'cargo';
const CARGO_PREFIX = WIN ? ['run', 'stable-x86_64-pc-windows-gnu', 'cargo'] : [];
const BIN_EXT = WIN ? '.exe' : '';
const BUILD_ARGS = prod ? ['build', '--bins', '--release'] : ['build', '--bins'];
const RUST_BIN_DIR = path.join(RUST_DIR, 'target', prod ? 'release' : 'debug');

if (!skipBuild) {
  console.log(`Building avail-api + avail-worker (rust-api/, ${prod ? 'release' : 'dev'}) …\n`);
  const build = spawnSync(CARGO, [...CARGO_PREFIX, ...BUILD_ARGS], {
    cwd: RUST_DIR,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    console.error('\nRust build failed — fix the error above and try again.');
    process.exit(build.status ?? 1);
  }
  console.log('');
}

const COLORS = {
  api: '\x1b[36m',
  worker: '\x1b[33m',
  proxy: '\x1b[35m',
  dashboard: '\x1b[32m',
};
const RESET = '\x1b[0m';

const NODE_FLAGS = ['--experimental-sqlite', '--no-warnings', '--import', 'tsx'];

const services = [
  {
    name: 'api',
    command: path.join(RUST_BIN_DIR, `avail-api${BIN_EXT}`),
    args: [],
    // Matches the API's own default so nothing downstream (dashboard's
    // Vite proxy, GitHub/Google OAuth callback URLs) needs reconfiguring.
    env: { RUST_API_PORT: process.env.RUST_API_PORT ?? '3001' },
  },
  {
    name: 'worker',
    command: path.join(RUST_BIN_DIR, `avail-worker${BIN_EXT}`),
    args: [],
  },
  {
    name: 'proxy',
    command: process.execPath,
    args: [...NODE_FLAGS, 'apps/proxy/src/server.ts'],
  },
  {
    name: 'dashboard',
    command: 'npm',
    args: prod
      ? ['run', 'preview', '-w', '@avail/dashboard']
      : ['run', 'dev', '-w', '@avail/dashboard'],
    // npm resolves to npm.cmd on Windows, which Node refuses to spawn directly.
    shell: WIN,
  },
].filter((service) => !only || only.includes(service.name));

const children = [];

function launch(service) {
  const child = spawn(service.command, service.args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '1', ...(service.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: service.shell ?? false,
  });

  const color = COLORS[service.name] ?? '';
  const prefix = `${color}[${service.name}]${RESET}`;

  const pipe = (stream, target) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('error', (err) => {
    process.stdout.write(`${prefix} failed to start: ${err.message}\n`);
    shutdown(1);
  });

  child.on('exit', (code, signal) => {
    process.stdout.write(
      `${prefix} exited (${signal ?? code}). Stopping the other services.\n`
    );
    shutdown(code ?? 1);
  });

  children.push(child);
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        if (WIN && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(`Starting Avail Deploy: ${services.map((s) => s.name).join(', ')}\n`);

// `api` opens the (WAL-mode) database first and alone. Starting every
// process at once races them all through schema init on the same file —
// harmless once it's warm, but on a database that still has an unclean
// -wal from a previous forceful kill, one connection has to run WAL
// recovery while it holds the lock, and `SQLITE_BUSY_RECOVERY` during that
// window isn't covered by `busy_timeout` on the very first pragma of a
// fresh connection. A short head start avoids the pile-up.
const first = services.find((s) => s.name === 'api');
const rest = services.filter((s) => s.name !== 'api');
if (first) launch(first);
setTimeout(() => {
  for (const service of rest) launch(service);
}, first ? 800 : 0);
