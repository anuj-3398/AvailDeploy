import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execPath, shQuote } from './paths.ts';
import { run, type LogSink } from './executor.ts';

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  ref: string;
}

export interface FetchOptions {
  /** `https://github.com/owner/repo.git`, or an absolute local path. */
  repoUrl: string;
  /** Branch, tag or commit-ish to check out. */
  ref: string;
  /** Exact commit to check out, when known. */
  sha?: string | null;
  /** Destination directory on the host filesystem. */
  dir: string;
  token?: string | null;
  log?: LogSink;
  signal?: AbortSignal;
  /** Full history instead of a shallow clone. */
  deep?: boolean;
  /** Where to write the generated shell script (kept out of the checkout). */
  scriptDir?: string;
}

/** Strips credentials so tokens never reach the build log. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***@');
}

function isLocalPath(repoUrl: string): boolean {
  return (
    repoUrl.startsWith('/') ||
    repoUrl.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(repoUrl)
  );
}

/**
 * Clones `repoUrl` at `ref` into `dir` and reports the resolved commit.
 * Runs through the build executor so the checkout happens in the same
 * environment the build will run in.
 */
export async function fetchSource(options: FetchOptions): Promise<CommitInfo> {
  const { repoUrl, ref, sha, dir, token, log, signal, deep } = options;
  const target = sha || ref;
  const depth = deep ? '' : '--depth 1';

  const remote = isLocalPath(repoUrl)
    ? execPath(repoUrl.replace(/^file:\/\//, ''))
    : repoUrl;

  log?.('info', `Cloning ${redactUrl(remote)} (${target})`);

  const commitFile = path.join(dir, '.avail-commit.txt');
  const credentialSetup =
    token && !isLocalPath(repoUrl)
      ? [
          'git config credential.helper ' +
            shQuote(
              `!f() { echo "username=x-access-token"; echo "password=$AVAIL_GIT_TOKEN"; }; f`
            ),
          'git config http.version HTTP/1.1',
        ].join('\n')
      : '';

  const script = [
    // Reuse an existing checkout so the fetch is incremental and, more
    // importantly, so node_modules and framework caches survive between
    // builds. A fresh directory falls back to init + fetch.
    'if [ -d .git ]; then',
    `  git remote set-url origin ${shQuote(remote)} 2>/dev/null || git remote add origin ${shQuote(remote)}`,
    'else',
    '  rm -rf .git',
    '  git init -q .',
    `  git remote add origin ${shQuote(remote)}`,
    'fi',
    credentialSetup,
    // Fetch the exact commit when we have one, else the branch tip.
    `git fetch -q ${depth} origin ${shQuote(target)} || git fetch -q ${depth} origin`,
    'git checkout -q --force FETCH_HEAD',
    // Drop files left by the previous commit. Ignored paths (node_modules,
    // .next, …) are deliberately kept — that is the whole point of reuse.
    'git clean -qfd -e node_modules',
    'git submodule update --init --recursive --depth 1 2>/dev/null || true',
    `git log -1 --pretty=format:'%H%n%an <%ae>%n%s' > ${shQuote('.avail-commit.txt')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await run({
    command: script,
    cwd: dir,
    env: token ? { AVAIL_GIT_TOKEN: token } : {},
    log,
    signal,
    label: 'fetch',
    scriptDir: options.scriptDir,
  });

  // The script embeds credentials; remove it as soon as it has run.
  const scriptPath = path.join(options.scriptDir ?? dir, '.avail-fetch.sh');
  if (existsSync(scriptPath)) rmSync(scriptPath, { force: true });

  if (result.code !== 0) {
    throw new Error(
      result.aborted
        ? 'Canceled while fetching source'
        : `Failed to fetch ${redactUrl(remote)} at ${target}`
    );
  }

  if (!existsSync(commitFile)) {
    throw new Error('Checkout succeeded but no commit metadata was produced');
  }
  const [commitSha = '', author = '', ...rest] = readFileSync(commitFile, 'utf8')
    .trim()
    .split('\n');
  rmSync(commitFile, { force: true });

  return {
    sha: commitSha.trim(),
    author: author.trim(),
    message: rest.join('\n').trim(),
    ref,
  };
}

/** Builds an authenticated HTTPS clone URL for a GitHub repository. */
export function githubCloneUrl(fullName: string): string {
  return `https://github.com/${fullName}.git`;
}
