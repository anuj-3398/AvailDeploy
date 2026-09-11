#!/usr/bin/env node
/**
 * Starts the whole platform: control-plane API, deployment proxy and the
 * dashboard, with interleaved, prefixed output.
 *
 *   npm run dev            all three, dashboard in Vite dev mode
 *   npm run start          API + proxy only (dashboard must be built)
 *   node scripts/dev.mjs --only api,proxy
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const prod = args.includes('--prod');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1])
      .split(',')
      .map((s) => s.trim())
  : null;

const COLORS = {
  api: '\x1b[36m',
  proxy: '\x1b[35m',
  dashboard: '\x1b[32m',
};
const RESET = '\x1b[0m';

const NODE_FLAGS = ['--experimental-sqlite', '--no-warnings', '--import', 'tsx'];

const services = [
  {
    name: 'api',
    command: process.execPath,
    args: [...NODE_FLAGS, 'apps/api/src/server.ts'],
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
    shell: process.platform === 'win32',
  },
].filter((service) => !only || only.includes(service.name));

const children = [];

function launch(service) {
  const child = spawn(service.command, service.args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '1' },
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
        if (process.platform === 'win32' && child.pid) {
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

console.log(
  `Starting Avail Deploy: ${services.map((s) => s.name).join(', ')}\n`
);
for (const service of services) launch(service);
