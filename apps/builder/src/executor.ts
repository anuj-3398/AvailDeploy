import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '@avail/shared/config';
import { execPath, shQuote } from './paths.ts';

export type LogSink = (
  level: 'info' | 'warn' | 'error' | 'command' | 'stdout' | 'stderr',
  text: string
) => void;

export interface RunOptions {
  /** Shell command to execute. */
  command: string;
  /** Working directory on the host filesystem. */
  cwd: string;
  env?: Record<string, string>;
  /** Where the generated shell script is written (defaults to cwd). */
  scriptDir?: string;
  log?: LogSink;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Label used for the generated script file. */
  label?: string;
}

export interface RunResult {
  code: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Renders a POSIX script that applies the environment and runs `command`.
 * Writing a file (instead of passing a long `-c` string) keeps quoting sane
 * across the Windows -> wsl.exe -> bash boundary.
 */
export function renderScript(
  command: string,
  cwd: string,
  env: Record<string, string>
): string {
  const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', ''];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`export ${key}=${shQuote(value)}`);
  }
  lines.push('');
  lines.push(`cd ${shQuote(execPath(cwd))}`);
  lines.push('');
  lines.push(command);
  lines.push('');
  return lines.join('\n');
}

function buildSpawn(scriptHostPath: string): {
  file: string;
  args: string[];
} {
  if (config.build.executor === 'wsl') {
    return {
      file: 'wsl.exe',
      args: ['-d', config.build.wslDistro, '--', 'bash', execPath(scriptHostPath)],
    };
  }
  return { file: 'bash', args: [scriptHostPath] };
}

/**
 * Runs a shell command through the configured executor (`wsl` or `local`),
 * streaming stdout/stderr line by line into `log`.
 */
export function run(options: RunOptions): Promise<RunResult> & {
  child: ChildProcess;
} {
  const {
    command,
    cwd,
    env = {},
    log,
    timeoutMs = config.build.timeoutMs,
    signal,
    label = 'step',
  } = options;

  const scriptDir = options.scriptDir ?? cwd;
  mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, `.avail-${label}.sh`);
  writeFileSync(scriptPath, renderScript(command, cwd, env), {
    encoding: 'utf8',
  });

  const { file, args } = buildSpawn(scriptPath);
  log?.('command', `$ ${command}`);

  const child = spawn(file, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const promise = new Promise<RunResult>((resolve) => {
    let timedOut = false;
    let aborted = false;

    const pipe = (
      stream: NodeJS.ReadableStream | null,
      level: 'stdout' | 'stderr'
    ) => {
      if (!stream) return;
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) log?.(level, line);
      });
      stream.on('end', () => {
        if (buffer.trim()) log?.(level, buffer);
      });
    };
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');

    // `timeoutMs <= 0` (or beyond the 32-bit timer range) means no timeout,
    // which is what long-lived runtime processes use.
    const timer =
      timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1
        ? setTimeout(() => {
            timedOut = true;
            log?.('error', `Timed out after ${Math.round(timeoutMs / 1000)}s`);
            kill(child);
          }, timeoutMs)
        : null;

    const onAbort = () => {
      aborted = true;
      log?.('warn', 'Build canceled');
      kill(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      log?.('error', `Failed to start command: ${err.message}`);
    });

    child.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? (sig ? 1 : 0), signal: sig, timedOut, aborted });
    });
  });

  return Object.assign(promise, { child });
}

/** Terminates a process tree started by {@link run}. */
export function kill(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }
  } catch {
    /* process already gone */
  }
}

/** Runs a command and returns its trimmed stdout, throwing on failure. */
export async function capture(
  options: Omit<RunOptions, 'log'>
): Promise<string> {
  let out = '';
  let err = '';
  const result = await run({
    ...options,
    log: (level, text) => {
      if (level === 'stdout') out += text + '\n';
      else if (level === 'stderr') err += text + '\n';
    },
  });
  if (result.code !== 0) {
    throw new Error(
      `Command failed (${result.code}): ${options.command}\n${err.trim() || out.trim()}`
    );
  }
  return out.trim();
}

/** Verifies the configured executor can run commands at all. */
export async function checkExecutor(): Promise<{ ok: boolean; detail: string }> {
  try {
    const out = await capture({
      command: 'node --version || echo "no-node"',
      cwd: config.dataDir,
      scriptDir: config.cacheDir,
      label: 'doctor',
      timeoutMs: 60_000,
    });
    return { ok: !out.includes('no-node'), detail: out };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}
