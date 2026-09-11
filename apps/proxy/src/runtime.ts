import { type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kill, run } from '@avail/builder';
import { execPath } from '@avail/builder';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import type { DeploymentManifest, FunctionEntry } from '@avail/shared/types';

const log = createLogger('runtime');

const FUNCTION_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'runtime',
  'function-server.mjs'
);

export interface RuntimeInstance {
  deploymentId: string;
  kind: 'functions' | 'server';
  /** Set only for `kind: 'functions'` — which route this process serves. */
  functionRoute?: string;
  port: number;
  child: ChildProcess;
  startedAt: number;
  lastUsedAt: number;
  ready: Promise<void>;
  logs: string[];
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (free: boolean) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(400);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

async function allocatePort(taken: Set<number>): Promise<number> {
  const { portRangeStart, portRangeEnd } = config.runtime;
  for (let attempt = 0; attempt < 200; attempt++) {
    const port =
      portRangeStart +
      Math.floor(Math.random() * (portRangeEnd - portRangeStart));
    if (taken.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error('No free runtime port available');
}

/** Waits until something accepts TCP connections on `port`. */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.setTimeout(1000);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Runtime did not start within ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 250);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

/**
 * Starts and supervises one process per deployment: either the serverless
 * function host, or the framework's own server for `server` deployments.
 * Instances are booted on first request and reaped when idle.
 */
class RuntimeManager {
  private instances = new Map<string, RuntimeInstance>();
  private starting = new Map<string, Promise<RuntimeInstance>>();
  private reaper: NodeJS.Timeout | null = null;

  constructor() {
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  get running() {
    return [...this.instances.values()].map((instance) => ({
      deploymentId: instance.deploymentId,
      kind: instance.kind,
      functionRoute: instance.functionRoute,
      port: instance.port,
      startedAt: instance.startedAt,
      lastUsedAt: instance.lastUsedAt,
      pid: instance.child.pid,
    }));
  }

  /**
   * Returns a booted instance, starting it if needed. `functionEntry`
   * isolates one serverless function into its own process — every function
   * in a deployment used to share a single `function-server.mjs` process
   * (one crash or memory leak in any handler took the rest down with it);
   * passing it here gives that one route its own key and its own child
   * process, with only that route ever loaded into it.
   */
  async acquire(
    deploymentId: string,
    deploymentDir: string,
    manifest: DeploymentManifest,
    kind: 'functions' | 'server',
    functionEntry?: FunctionEntry
  ): Promise<RuntimeInstance> {
    const key = instanceKey(deploymentId, kind, functionEntry);
    const existing = this.instances.get(key);
    if (existing && existing.child.exitCode === null) {
      existing.lastUsedAt = Date.now();
      await existing.ready;
      return existing;
    }
    if (existing) this.instances.delete(key);

    const pending = this.starting.get(key);
    if (pending) return pending;

    const boot = this.boot(key, deploymentId, deploymentDir, manifest, kind, functionEntry).finally(
      () => this.starting.delete(key)
    );
    this.starting.set(key, boot);
    return boot;
  }

  private async boot(
    key: string,
    deploymentId: string,
    deploymentDir: string,
    manifest: DeploymentManifest,
    kind: 'functions' | 'server',
    functionEntry?: FunctionEntry
  ): Promise<RuntimeInstance> {
    const taken = new Set([...this.instances.values()].map((i) => i.port));
    const port = await allocatePort(taken);

    const workDir = path.resolve(
      deploymentDir,
      (kind === 'server' ? manifest.serverDir : manifest.functionsDir) ?? 'src'
    );

    const env: Record<string, string> = {
      ...manifest.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '0.0.0.0',
      HOSTNAME: '0.0.0.0',
      AVAIL_RUNTIME_PORT: String(port),
      AVAIL_WORKDIR: execPath(workDir),
      AVAIL_DEPLOYMENT_ID: deploymentId,
    };

    let command: string;
    if (kind === 'functions') {
      // Only the one function this process was booted for — never the
      // whole deployment's route table — so a crash in one handler can't
      // take a sibling function down with it.
      env.AVAIL_FUNCTIONS = JSON.stringify(functionEntry ? [functionEntry] : manifest.functions);
      env.AVAIL_FUNCTION_TIMEOUT = String(config.runtime.maxDurationSec);
      command = `node --experimental-strip-types --no-warnings ${JSON.stringify(
        execPath(FUNCTION_SERVER)
      )}`;
    } else {
      if (!manifest.startCommand) {
        throw new Error('Deployment has no start command');
      }
      command = manifest.startCommand;
    }

    const logs: string[] = [];
    const capture = (level: string, text: string) => {
      if (!text) return;
      logs.push(`[${level}] ${text}`);
      if (logs.length > 300) logs.shift();
      if (process.env.DEBUG) log.debug(`${deploymentId}: ${text}`);
    };

    const prelude = [
      'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
      '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
      'export PATH="$PWD/node_modules/.bin:$PATH"',
    ].join('\n');

    const execution = run({
      command: `${prelude}\n${command}`,
      cwd: workDir,
      env,
      log: (level, text) => capture(level, text),
      timeoutMs: 0, // long-lived: never time out
      label: `runtime-${kind}`,
      scriptDir: deploymentDir,
    });

    const instance: RuntimeInstance = {
      deploymentId,
      kind,
      functionRoute: functionEntry?.route,
      port,
      child: execution.child,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      ready: waitForPort(port, config.runtime.bootTimeoutMs),
      logs,
    };

    const label = functionEntry ? `${deploymentId} ${functionEntry.route}` : deploymentId;

    execution.then((result) => {
      log.info(`Runtime ${label} (${kind}) exited with code ${result.code}`);
      this.instances.delete(key);
    });

    this.instances.set(key, instance);

    try {
      await instance.ready;
      log.info(`Started ${kind} runtime for ${label} on port ${port}`);
    } catch (err) {
      this.stop(key);
      throw new Error(
        `${(err as Error).message}\n${logs.slice(-25).join('\n')}`
      );
    }

    return instance;
  }

  /** `key` is whatever `acquire` computed — a deployment id for `server`
   * and combined server-mode runtimes, or `<deploymentId>:fn:<route>` for
   * one isolated function's process. */
  stop(key: string): void {
    const instance = this.instances.get(key);
    if (!instance) return;
    kill(instance.child);
    this.instances.delete(key);
    log.info(`Stopped runtime for ${key}`);
  }

  stopAll(): void {
    for (const key of [...this.instances.keys()]) {
      this.stop(key);
    }
  }

  private reapIdle(): void {
    const cutoff = Date.now() - config.runtime.idleTimeoutMs;
    for (const [key, instance] of [...this.instances.entries()]) {
      if (instance.lastUsedAt < cutoff) {
        log.info(`Reaping idle runtime ${key}`);
        this.stop(key);
      }
    }
  }
}

function instanceKey(deploymentId: string, kind: 'functions' | 'server', functionEntry?: FunctionEntry): string {
  return functionEntry ? `${deploymentId}:fn:${functionEntry.route}` : deploymentId;
}

export const runtimes = new RuntimeManager();
