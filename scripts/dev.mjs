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
 *   node scripts/dev.mjs --no-watch     (disable Rust auto-rebuild/restart)
 *
 * In dev mode (not --prod), rust-api/src (plus Cargo.toml/Cargo.lock) is
 * watched: a change rebuilds avail-api/avail-worker and, on success,
 * restarts just those two processes — proxy and the dashboard keep running
 * and never need a manual `npm run dev` restart for a Rust-only change.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUST_DIR = path.join(ROOT, 'rust-api');
const WIN = process.platform === 'win32';

const args = process.argv.slice(2);
const prod = args.includes('--prod');
const skipBuild = args.includes('--skip-build');
const noWatch = args.includes('--no-watch');
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

// api/worker are actually launched from a *copy* of cargo's build output,
// not target/.../avail-{api,worker}.exe directly. On Windows, a running
// .exe has its file locked — cargo cannot even delete it, let alone write
// the rebuilt one, so a watch-triggered rebuild while the old process is up
// fails outright with "Access is denied" (verified: this is not
// theoretical, it reproduces every time). Building always targets the real
// (unlocked) path; syncRunBinaries() below copies the result into `run/`
// only after the old copy's process has been killed.
const RUST_RUN_DIR = path.join(RUST_BIN_DIR, 'run');
function syncRunBinaries(names) {
  fs.mkdirSync(RUST_RUN_DIR, { recursive: true });
  for (const name of names) {
    fs.copyFileSync(
      path.join(RUST_BIN_DIR, `${name}${BIN_EXT}`),
      path.join(RUST_RUN_DIR, `${name}${BIN_EXT}`)
    );
  }
}

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
    command: path.join(RUST_RUN_DIR, `avail-api${BIN_EXT}`),
    args: [],
    // Matches the API's own default so nothing downstream (dashboard's
    // Vite proxy, GitHub/Google OAuth callback URLs) needs reconfiguring.
    env: { RUST_API_PORT: process.env.RUST_API_PORT ?? '3001' },
  },
  {
    name: 'worker',
    command: path.join(RUST_RUN_DIR, `avail-worker${BIN_EXT}`),
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

// Keyed by service name so a Rust auto-restart can look up and replace just
// `api`/`worker` without touching `proxy`/`dashboard`. `intentionalExits`
// holds pids we killed ourselves (a restart) so the exit handler below
// knows not to treat that death as a crash and tear down everything else.
const childrenByName = new Map();
const intentionalExits = new Set();

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
    if (child.pid && intentionalExits.delete(child.pid)) {
      // Killed on purpose for an auto-restart — the restart logic relaunches
      // it itself, so don't treat this as a crash.
      return;
    }
    process.stdout.write(
      `${prefix} exited (${signal ?? code}). Stopping the other services.\n`
    );
    shutdown(code ?? 1);
  });

  childrenByName.set(service.name, child);
  return child;
}

// Kills `child` and resolves once it's actually gone. Bounded by a timeout
// so a `taskkill` that never lands (permissions, an already-vanished pid,
// whatever) can't hang the watch-rebuild-restart pipeline forever — a stuck
// promise here would silently stop every future auto-restart.
function killChild(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    if (child.pid) intentionalExits.add(child.pid);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      process.stdout.write(
        `[watch] pid ${child.pid} hasn't exited after ${timeoutMs}ms; continuing anyway (it may still be running).\n`
      );
      finish();
    }, timeoutMs);
    child.once('exit', finish);
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
      finish();
    }
  });
}

// The in-flight `cargo build` triggered by the watcher, if any — tracked so
// shutdown() can also reap it. It shares the console's stdio (inherit), so
// on Windows it usually dies with the console group on Ctrl+C anyway, but
// that's not guaranteed (e.g. a SIGTERM from a process manager instead),
// and leaving a stray `cargo`/`rustc` running after `npm run dev` exits is
// exactly the kind of manual-cleanup friction this feature exists to avoid.
let buildChild = null;

function killTree(child) {
  if (!child || child.exitCode !== null) return;
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

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of childrenByName.values()) killTree(child);
  killTree(buildChild);
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const rustServiceNames = services.filter((s) => s.name === 'api' || s.name === 'worker').map((s) => s.name);
if (rustServiceNames.length > 0) {
  try {
    syncRunBinaries(rustServiceNames.map((n) => `avail-${n}`));
  } catch (err) {
    console.error(
      `Could not stage avail-api/avail-worker into ${RUST_RUN_DIR}: ${err.message}\n` +
        'If this is "access denied", an orphaned avail-api.exe/avail-worker.exe from a previous ' +
        'run may still be holding the file open — check Task Manager and end it, then retry.'
    );
    process.exit(1);
  }
}

console.log(`Starting Avail Harbor: ${services.map((s) => s.name).join(', ')}\n`);

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

// --- Rust auto-rebuild + restart (dev mode only) ---------------------------
//
// Watches rust-api/src (plus Cargo.toml/Cargo.lock) and, on change, rebuilds
// with the same cargo invocation used above and — only if that succeeds —
// kills and relaunches just `api`/`worker`, reusing the same 800ms stagger
// between them for the WAL-recovery race described above. `proxy` and the
// dashboard are never touched. A failed build leaves the currently-running
// api/worker alone and just prints the error, so one bad save doesn't kill
// the dev session.
// `busy` spans the *whole* cycle — build AND restart — not just the build.
// Clearing it right after the build (before awaiting the restart) would let
// a change that lands mid-restart kick off a second `cargo build` that
// writes the very same .exe the restart is still killing/relaunching from;
// on Windows that's a sharp edge (the file is mid-swap under a running
// process). Keeping `busy` true across both phases forces that change to
// simply queue instead.
let busy = false;
let rebuildQueued = false;
let watchDebounce = null;
let buildGeneration = 0;

async function restartRustServices() {
  const targets = services.filter(
    (s) => (s.name === 'api' || s.name === 'worker') && childrenByName.has(s.name)
  );
  if (targets.length === 0) return;

  await Promise.all(targets.map((s) => killChild(childrenByName.get(s.name))));

  // Only safe to overwrite the run/ copies now that their processes are
  // dead — see the RUST_RUN_DIR comment up top for why they aren't built
  // into directly. If this fails, api/worker are left stopped rather than
  // relaunched from a stale or half-written binary; the next successful
  // rebuild (or a manual `npm run dev`) recovers.
  try {
    syncRunBinaries(targets.map((s) => `avail-${s.name}`));
  } catch (err) {
    console.error(
      `[watch] Could not stage the rebuilt binaries (${err.message}). api/worker are stopped — fix this (an orphaned .exe still open?) and restart npm run dev.\n`
    );
    return;
  }

  const apiSvc = targets.find((s) => s.name === 'api');
  const workerSvc = targets.find((s) => s.name === 'worker');
  if (apiSvc) launch(apiSvc);
  if (apiSvc && workerSvc) await new Promise((r) => setTimeout(r, 800));
  if (workerSvc) launch(workerSvc);
}

function triggerRebuild(changedPath) {
  if (busy) {
    rebuildQueued = true;
    return;
  }
  busy = true;
  const generation = ++buildGeneration;
  const rel = changedPath ? path.relative(RUST_DIR, changedPath) : '';
  console.log(`\n[watch]${rel ? ` ${rel} changed —` : ''} rebuilding avail-api + avail-worker …\n`);

  const build = spawn(CARGO, [...CARGO_PREFIX, ...BUILD_ARGS], { cwd: RUST_DIR, stdio: 'inherit' });
  buildChild = build;

  const finishCycle = () => {
    busy = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      triggerRebuild();
    }
  };

  build.on('exit', (code) => {
    if (buildChild === build) buildChild = null;
    if (shuttingDown || generation !== buildGeneration) return; // superseded/torn down — nothing to finish
    if (code === 0) {
      console.log('\n[watch] Build OK — restarting api/worker …\n');
      restartRustServices()
        .then(() => console.log('[watch] api/worker back up.\n'))
        .catch((err) => console.error(`[watch] Restart failed: ${err.message}\n`))
        .finally(finishCycle);
    } else {
      console.error(
        `\n[watch] Build failed (exit ${code ?? '?'}) — leaving the running api/worker as-is. Fix the error and save again.\n`
      );
      finishCycle();
    }
  });
  build.on('error', (err) => {
    if (buildChild === build) buildChild = null;
    console.error(`[watch] Failed to run cargo: ${err.message}`);
    finishCycle();
  });
}

function scheduleRebuild(changedPath) {
  clearTimeout(watchDebounce);
  watchDebounce = setTimeout(() => triggerRebuild(changedPath), 400);
}

// sha1 of each watched file's last-seen content, so an event that didn't
// actually change bytes doesn't queue a rebuild. This matters for more than
// noise-reduction: `cargo build` can itself touch Cargo.lock's mtime with
// no content change, and without this guard that would requeue another
// rebuild the moment the current one finishes — a self-sustaining loop.
const lastHashes = new Map();
function contentChanged(filePath) {
  let hash;
  try {
    hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    // Deleted, mid-write, or otherwise unreadable — err toward rebuilding;
    // the build itself will surface a clearer error if something's wrong.
    lastHashes.delete(filePath);
    return true;
  }
  const changed = lastHashes.get(filePath) !== hash;
  lastHashes.set(filePath, hash);
  return changed;
}

const RS_TEMP_FILE = /(?:^|[\\/])(?:4913)$/i; // vim's atomic-write probe file
const IGNORED_SUFFIX = /(~|\.swp|\.swx|\.tmp|\.bak)$/i;

if (!prod && !noWatch && services.some((s) => s.name === 'api' || s.name === 'worker')) {
  const srcDir = path.join(RUST_DIR, 'src');
  try {
    const srcWatcher = fs.watch(srcDir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        scheduleRebuild(); // watcher couldn't name the file — be conservative
        return;
      }
      if (RS_TEMP_FILE.test(filename) || IGNORED_SUFFIX.test(filename)) return;
      if (!filename.toLowerCase().endsWith('.rs')) return; // only source edits matter here
      const full = path.join(srcDir, filename);
      if (!contentChanged(full)) return;
      scheduleRebuild(full);
    });
    const rootWatcher = fs.watch(RUST_DIR, (_event, filename) => {
      if (filename !== 'Cargo.toml' && filename !== 'Cargo.lock') return;
      const full = path.join(RUST_DIR, filename);
      if (!contentChanged(full)) return;
      scheduleRebuild(full);
    });
    // An FSWatcher with no 'error' listener throws on the next tick and
    // takes the whole dev server down with it — e.g. if rust-api/src is
    // ever removed or renamed out from under the watch while running.
    const onWatchError = (label) => (err) => {
      console.error(`[watch] ${label} watcher stopped: ${err.message} (Rust changes now need a manual restart)\n`);
    };
    srcWatcher.on('error', onWatchError('rust-api/src'));
    rootWatcher.on('error', onWatchError('rust-api'));
    process.on('exit', () => {
      srcWatcher.close();
      rootWatcher.close();
    });
    console.log('Watching rust-api/src for changes — api/worker will rebuild and restart automatically.\n');
  } catch (err) {
    console.error(
      `[watch] Could not watch rust-api/src (${err.message}); Rust changes will need a manual restart. Pass --no-watch to silence this.\n`
    );
  }
}
