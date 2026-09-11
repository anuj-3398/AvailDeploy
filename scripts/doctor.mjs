#!/usr/bin/env node
/**
 * Checks that the host can actually run the platform: Node version, WSL or
 * local shell availability, git, writable data directory and free ports.
 *
 *   npm run doctor
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const results = [];
const ok = (name, detail) => results.push({ name, state: 'ok', detail });
const warn = (name, detail) => results.push({ name, state: 'warn', detail });
const fail = (name, detail) => results.push({ name, state: 'fail', detail });

const { config, dataDirIsNested } = await import(
  '../packages/shared/src/config.ts'
);

/* ------------------------------------------------------------------ node */

const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok('Node.js', `v${process.versions.node}`);
else fail('Node.js', `v${process.versions.node} — 22 or newer is required`);

/* -------------------------------------------------------------- executor */

function runShell(command) {
  if (config.build.executor === 'wsl') {
    return spawnSync(
      'wsl.exe',
      ['-d', config.build.wslDistro, '--', 'bash', '-lc', command],
      { encoding: 'utf8', windowsHide: true }
    );
  }
  return spawnSync('bash', ['-lc', command], { encoding: 'utf8' });
}

const shell = runShell('echo shell-ok');
if (shell.status === 0 && String(shell.stdout).includes('shell-ok')) {
  ok('Build executor', `${config.build.executor} (${config.build.wslDistro})`);

  const nodeCheck = runShell('node --version 2>/dev/null || echo missing');
  const version = String(nodeCheck.stdout).trim().split('\n').pop();
  if (version && version !== 'missing') {
    const buildMajor = Number(version.replace(/^v/, '').split('.')[0]);
    if (buildMajor >= 18) ok('Node inside executor', version);
    else warn('Node inside executor', `${version} — builds may fail`);
  } else {
    fail(
      'Node inside executor',
      'Node is not installed in the build environment. Install it (nvm is detected automatically).'
    );
  }

  const gitCheck = runShell('git --version 2>/dev/null || echo missing');
  const gitVersion = String(gitCheck.stdout).trim().split('\n').pop();
  if (gitVersion && gitVersion !== 'missing') ok('Git inside executor', gitVersion);
  else fail('Git inside executor', 'git is required to fetch source');
} else {
  fail(
    'Build executor',
    `${config.build.executor} is not usable: ${(shell.stderr || shell.error?.message || '').trim().slice(0, 160)}`
  );
}

/* ------------------------------------------------------------- data dir */

try {
  mkdirSync(config.dataDir, { recursive: true });
  const probe = path.join(config.dataDir, '.write-probe');
  writeFileSync(probe, 'ok');
  rmSync(probe, { force: true });
  ok('Data directory', config.dataDir);
} catch (err) {
  fail('Data directory', `${config.dataDir} is not writable: ${err.message}`);
}

if (config.workspaceIsNative) {
  ok('Build workspace', `${config.workspaceDir} (${config.workspaceReason})`);
} else {
  warn(
    'Build workspace',
    `${config.workspaceDir} — ${config.workspaceReason}. ` +
      'Builds on a Windows drive cross the WSL 9p bridge for every dependency ' +
      'file, which dominates build time.'
  );
}

if (dataDirIsNested()) {
  fail(
    'Build isolation',
    'The data directory is inside the platform repository, so builds will ' +
      "resolve the platform's node_modules. Set AVAIL_DATA_DIR elsewhere."
  );
} else {
  ok('Build isolation', 'Builds run outside the platform repository');
}

/* --------------------------------------------------------------- sqlite */

try {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE probe (id INTEGER)');
  db.close();
  ok('SQLite', 'node:sqlite available');
} catch (err) {
  fail(
    'SQLite',
    `node:sqlite unavailable (${err.message}). Run with --experimental-sqlite.`
  );
}

/* ---------------------------------------------------------------- ports */

/** A port counts as taken if anything is listening on IPv4 or IPv6. */
function portFree(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, host);
    });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((results) =>
    results.every(Boolean)
  );
}

for (const [label, port] of [
  ['Dashboard', config.dashboardPort],
  ['API', config.apiPort],
  ['Proxy', config.proxyPort],
]) {
  if (await portFree(port)) ok(`${label} port`, String(port));
  else warn(`${label} port`, `${port} is already in use`);
}

/* ----------------------------------------------------------------- auth */

if (config.secret === 'dev-insecure-secret-change-me') {
  warn('AVAIL_SECRET', 'Still the default. Set it before anyone else uses this.');
} else {
  ok('AVAIL_SECRET', 'configured');
}

ok('Allowed domains', config.allowedEmailDomains.map((d) => `@${d}`).join(', '));
ok(
  'Deployment domain',
  `*.${config.deploymentDomain}:${config.proxyPort}`
);

/* ---------------------------------------------------------------- print */

const ICONS = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };
console.log('\nAvail Deploy — environment check\n');
for (const result of results) {
  console.log(
    `${ICONS[result.state]} ${result.name.padEnd(24)} ${result.detail ?? ''}`
  );
}

const failures = results.filter((r) => r.state === 'fail').length;
const warnings = results.filter((r) => r.state === 'warn').length;
console.log(
  `\n${failures ? `\x1b[31m${failures} blocking issue(s)\x1b[0m` : '\x1b[32mNo blocking issues\x1b[0m'}` +
    (warnings ? `, ${warnings} warning(s)` : '') +
    '\n'
);
process.exit(failures ? 1 : 0);
