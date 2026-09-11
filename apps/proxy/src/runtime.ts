import { type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kill, run } from '@avail/builder';
import { execPath } from '@avail/builder';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import type { DeploymentManifest } from '@avail/shared/types';

const log = createLogger('runtime');

const FUNCTION_SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'runtime',
  'function-server.mjs'
);

export interface RuntimeInstance {
  deploymentId: string;
  kind: 'functions' | 'server';
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
      port: instance.port,
      startedAt: instance.startedAt,
      lastUsedAt: instance.lastUsedAt,
      pid: instance.child.pid,
    }));
  }

  /** Returns a booted instance for the deployment, starting it if needed. */
  async acquire(
    deploymentId: string,
    deploymentDir: string,
    manifest: DeploymentManifest,
    kind: 'functions' | 'server'
  ): Promise<RuntimeInstance> {
    const existing = this.instances.get(deploymentId);
    if (existing && existing.child.exitCode === null) {
      existing.lastUsedAt = Date.now();
      await existing.ready;
      return existing;
    }
    if (existing) this.instances.delete(deploymentId);

    const pending = this.starting.get(deploymentId);
    if (pending) return pending;

    const boot = this.boot(deploymentId, deploymentDir, manifest, kind).finally(
      () => this.starting.delete(deploymentId)
    );
    this.starting.set(deploymentId, boot);
    return boot;
  }

  private async boot(
    deploymentId: string,
    deploymentDir: string,
    manifest: DeploymentManifest,
    kind: 'functions' | 'server'
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
      env.AVAIL_FUNCTIONS = JSON.stringify(manifest.functions);
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
      port,
      child: execution.child,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
      ready: waitForPort(port, config.runtime.bootTimeoutMs),
      logs,
    };

    execution.then((result) => {
      log.info(
        `Runtime ${deploymentId} (${kind}) exited with code ${result.code}`
      );
      this.instances.delete(deploymentId);
    });

    this.instances.set(deploymentId, instance);

    try {
      await instance.ready;
      log.info(`Started ${kind} runtime for ${deploymentId} on port ${port}`);
    } catch (err) {
      this.stop(deploymentId);
      throw new Error(
        `${(err as Error).message}\n${logs.slice(-25).join('\n')}`
      );
    }

    return instance;
  }

  stop(deploymentId: string): void {
    const instance = this.instances.get(deploymentId);
    if (!instance) return;
    kill(instance.child);
    this.instances.delete(deploymentId);
    log.info(`Stopped runtime for ${deploymentId}`);
  }

  stopAll(): void {
    for (const deploymentId of [...this.instances.keys()]) {
      this.stop(deploymentId);
    }
  }

  private reapIdle(): void {
    const cutoff = Date.now() - config.runtime.idleTimeoutMs;
    for (const instance of [...this.instances.values()]) {
      if (instance.lastUsedAt < cutoff) {
        log.info(`Reaping idle runtime ${instance.deploymentId}`);
        this.stop(instance.deploymentId);
      }
    }
  }
}

export const runtimes = new RuntimeManager();
