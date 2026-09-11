import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getFramework } from '@avail/frameworks';
import { config } from '@avail/shared/config';
import type {
  Deployment,
  DeploymentManifest,
  FunctionEntry,
  Project,
  ServeMode,
} from '@avail/shared/types';
import { run, type LogSink } from './executor.ts';
import { discoverFunctions } from './functions.ts';
import { fetchSource, githubCloneUrl, type CommitInfo } from './git.ts';
import { readProjectConfig, resolveOutputDirectory, resolveSettings } from './settings.ts';
import { execPath, shQuote } from './paths.ts';

export { checkExecutor, kill, run } from './executor.ts';
export { toWslPath, execPath } from './paths.ts';

export type BuildPhase =
  | 'initializing'
  | 'cloning'
  | 'restoring-cache'
  | 'installing'
  | 'building'
  | 'collecting'
  | 'done';

export interface BuildInput {
  deployment: Deployment;
  project: Project;
  /** Decrypted environment variables for this deployment's target. */
  env: Record<string, string>;
  /** Git access token for private repositories. */
  gitToken?: string | null;
  /** Overrides the repository URL (used for local-path test projects). */
  repoUrl?: string | null;
  log: LogSink;
  signal: AbortSignal;
  onPhase?: (phase: BuildPhase) => void;
}

export interface BuildOutput {
  commit: CommitInfo;
  framework: string | null;
  serveMode: ServeMode;
  startCommand: string | null;
  /** Directory served by the proxy, relative to the deployment directory. */
  outputPath: string | null;
  functions: FunctionEntry[];
  manifest: DeploymentManifest;
  durationMs: number;
}

/** Directory layout for one deployment on disk. */
export function deploymentPaths(deploymentId: string) {
  const dir = path.join(config.deploymentsDir, deploymentId);
  return {
    dir,
    src: path.join(dir, 'src'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

/**
 * Best-effort prelude that makes the requested Node version and package
 * managers available inside the build shell.
 */
function toolchainPrelude(nodeVersion: string): string {
  const major = nodeVersion.replace(/[^\d].*$/, '') || '22';
  return [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '# shellcheck disable=SC1091',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true',
    `command -v nvm >/dev/null 2>&1 && { nvm use ${major} >/dev/null 2>&1 || nvm install ${major} >/dev/null 2>&1 || true; }`,
    'corepack enable >/dev/null 2>&1 || true',
    'echo "Node $(node --version) / npm $(npm --version)"',
  ].join('\n');
}

/**
 * System environment exposed to every build, mirroring Vercel's variables so
 * that existing projects work unchanged, plus `AVAIL_*` equivalents.
 */
export function systemEnv(
  deployment: Deployment,
  project: Project,
  commit: CommitInfo | null
): Record<string, string> {
  const env: Record<string, string> = {
    CI: '1',
    NODE_ENV: 'production',
    AVAIL: '1',
    AVAIL_ENV: deployment.target,
    AVAIL_URL: deployment.url,
    AVAIL_DEPLOYMENT_ID: deployment.id,
    AVAIL_PROJECT_ID: project.id,
    AVAIL_PROJECT_NAME: project.name,
    AVAIL_TARGET_ENV: deployment.target,
    // Vercel-compatible aliases so unmodified projects build as-is.
    VERCEL: '1',
    VERCEL_ENV: deployment.target,
    VERCEL_URL: deployment.url,
    VERCEL_TARGET_ENV: deployment.target,
    NEXT_TELEMETRY_DISABLED: '1',
    TURBO_TELEMETRY_DISABLED: '1',
    ASTRO_TELEMETRY_DISABLED: '1',
  };
  if (project.repo_full_name) {
    env.AVAIL_GIT_REPO_SLUG = project.repo_full_name;
    env.VERCEL_GIT_REPO_SLUG = project.repo_full_name;
    env.VERCEL_GIT_PROVIDER = project.repo_provider ?? 'github';
  }
  const branch = deployment.branch ?? '';
  if (branch) {
    env.AVAIL_GIT_COMMIT_REF = branch;
    env.VERCEL_GIT_COMMIT_REF = branch;
  }
  if (commit?.sha) {
    env.AVAIL_GIT_COMMIT_SHA = commit.sha;
    env.VERCEL_GIT_COMMIT_SHA = commit.sha;
    env.AVAIL_GIT_COMMIT_MESSAGE = commit.message;
    env.VERCEL_GIT_COMMIT_MESSAGE = commit.message;
    env.AVAIL_GIT_COMMIT_AUTHOR_NAME = commit.author;
    env.VERCEL_GIT_COMMIT_AUTHOR_NAME = commit.author;
  }
  return env;
}

function cacheArchive(projectId: string): string {
  return path.join(config.cacheDir, `${projectId}.tar`);
}

/** Restores `node_modules` and the framework build cache from a previous run. */
async function restoreCache(
  projectId: string,
  workDir: string,
  log: LogSink,
  signal: AbortSignal
): Promise<boolean> {
  const archive = cacheArchive(projectId);
  if (!existsSync(archive)) return false;
  const result = await run({
    command: `tar -xf ${shQuote(execPath(archive))} -C . 2>/dev/null || true`,
    cwd: workDir,
    log: (level, text) => log(level === 'stdout' ? 'info' : level, text),
    signal,
    label: 'cache-restore',
    timeoutMs: 5 * 60_000,
  });
  return result.code === 0;
}

/** Saves `node_modules` and the framework build cache for the next build. */
async function saveCache(
  projectId: string,
  workDir: string,
  frameworkSlug: string | null,
  log: LogSink,
  signal: AbortSignal
): Promise<void> {
  mkdirSync(config.cacheDir, { recursive: true });
  const archive = cacheArchive(projectId);
  const cachePattern = getFramework(frameworkSlug)?.cachePattern ?? null;
  const extra = cachePattern ? cachePattern.replace(/\/\*\*$/, '') : null;
  const targets = ['node_modules', ...(extra ? [extra] : [])]
    .filter((t) => existsSync(path.join(workDir, t)))
    .map((t) => shQuote(t));
  if (!targets.length) return;

  await run({
    command: `tar -cf ${shQuote(execPath(archive))} ${targets.join(' ')} 2>/dev/null || true`,
    cwd: workDir,
    log: () => {},
    signal,
    label: 'cache-save',
    timeoutMs: 5 * 60_000,
  });
  log('info', 'Build cache saved');
}

/**
 * Runs a complete deployment build: fetch source, resolve settings, install,
 * build, then collect the output into an immutable deployment directory.
 */
export async function runBuild(input: BuildInput): Promise<BuildOutput> {
  const { deployment, project, log, signal, onPhase } = input;
  const started = Date.now();
  const paths = deploymentPaths(deployment.id);

  onPhase?.('initializing');
  mkdirSync(paths.src, { recursive: true });
  log('info', `Deploying ${project.name} (${deployment.target})`);
  log('info', `Build executor: ${config.build.executor}`);

  /* --------------------------------------------------------------- clone */
  onPhase?.('cloning');
  const repoUrl =
    input.repoUrl ??
    (project.repo_full_name ? githubCloneUrl(project.repo_full_name) : null);
  if (!repoUrl) {
    throw new Error('Project has no repository configured');
  }

  const commit = await fetchSource({
    repoUrl,
    ref: deployment.branch || project.production_branch,
    sha: deployment.commit_sha,
    dir: paths.src,
    token: input.gitToken,
    log,
    signal,
  });
  log('info', `Checked out ${commit.sha.slice(0, 7)} — ${commit.message}`);

  /* ------------------------------------------------------------ settings */
  const rootConfig = readProjectConfig(paths.src);
  const resolved = resolveSettings({
    repoDir: paths.src,
    project,
    configFile: project.root_directory ? undefined : rootConfig,
  });
  const { settings, configFile, workDir } = resolved;

  if (resolved.detectedFramework && !project.framework) {
    log('info', `Detected framework: ${resolved.detectedFramework}`);
  }
  log('info', `Root directory: ${settings.rootDirectory}`);
  log('info', `Package manager: ${resolved.packageManager}`);

  const env = {
    ...systemEnv(deployment, project, commit),
    ...input.env,
  };
  const prelude = toolchainPrelude(settings.nodeVersion);

  /* ------------------------------------------------------------- install */
  if (existsSync(path.join(workDir, 'package.json'))) {
    onPhase?.('restoring-cache');
    if (await restoreCache(project.id, workDir, log, signal)) {
      log('info', 'Restored build cache');
    }
  }

  if (settings.installCommand) {
    onPhase?.('installing');
    log('info', 'Installing dependencies');
    const result = await run({
      command: `${prelude}\n${settings.installCommand}`,
      cwd: workDir,
      // Package managers omit devDependencies when NODE_ENV=production, and
      // build tooling lives there. Install in development mode, build in
      // production mode — the same split Vercel uses.
      env: { ...env, NODE_ENV: 'development' },
      log,
      signal,
      label: 'install',
    });
    if (result.code !== 0) {
      throw new Error(
        result.aborted
          ? 'Canceled during install'
          : `Install failed with exit code ${result.code}`
      );
    }
  } else {
    log('info', 'No install command — skipping');
  }

  /* --------------------------------------------------------------- build */
  if (settings.buildCommand) {
    onPhase?.('building');
    log('info', 'Running build command');
    const result = await run({
      command: `${prelude}\n${settings.buildCommand}`,
      cwd: workDir,
      env,
      log,
      signal,
      label: 'build',
    });
    if (result.code !== 0) {
      throw new Error(
        result.aborted
          ? 'Canceled during build'
          : `Build failed with exit code ${result.code}`
      );
    }
  } else {
    log('info', 'No build command — serving the repository as-is');
  }

  /* ------------------------------------------------------------ collect */
  onPhase?.('collecting');
  const functions = discoverFunctions(workDir, configFile.functions ?? {});
  if (functions.length) {
    log('info', `Discovered ${functions.length} serverless function(s):`);
    for (const fn of functions) log('info', `  ${fn.route}  ->  ${fn.file}`);
  }

  let serveMode = settings.serveMode;
  let staticDir: string | null = null;
  let outputPath: string | null = null;

  if (serveMode === 'static') {
    const outputDirectory = resolveOutputDirectory(
      workDir,
      settings.outputDirectory,
      settings.framework
    );
    if (!outputDirectory) {
      // No build output: serve the working directory itself (plain static site).
      staticDir = path.relative(paths.dir, workDir).split(path.sep).join('/');
      log(
        'warn',
        `No output directory found${
          settings.outputDirectory ? ` at "${settings.outputDirectory}"` : ''
        } — serving the root directory`
      );
    } else {
      const abs = path.join(workDir, outputDirectory);
      staticDir = path.relative(paths.dir, abs).split(path.sep).join('/');
      log('info', `Output directory: ${outputDirectory}`);
    }
    outputPath = staticDir;
  } else {
    if (!settings.startCommand) {
      throw new Error(
        `Framework "${settings.framework}" needs a start command. Set "startCommand" in avail.json or add a "start" script.`
      );
    }
    outputPath = path.relative(paths.dir, workDir).split(path.sep).join('/');
    log('info', `Serve mode: server (${settings.startCommand})`);
  }

  await saveCache(project.id, workDir, settings.framework, log, signal).catch(
    () => {}
  );

  const manifest: DeploymentManifest = {
    deploymentId: deployment.id,
    projectId: project.id,
    projectSlug: project.slug,
    target: deployment.target,
    framework: settings.framework,
    serveMode,
    startCommand: settings.startCommand,
    staticDir,
    functionsDir: functions.length
      ? path.relative(paths.dir, workDir).split(path.sep).join('/')
      : null,
    serverDir: path.relative(paths.dir, workDir).split(path.sep).join('/'),
    functions,
    config: configFile,
    env: {
      ...input.env,
      ...systemEnv(deployment, project, commit),
      NODE_ENV: 'production',
    },
    nodeVersion: settings.nodeVersion,
    createdAt: Date.now(),
  };
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));

  // Build scripts can contain credentials; they are not part of the artifact.
  for (const name of ['.avail-install.sh', '.avail-build.sh', '.avail-fetch.sh']) {
    rmSync(path.join(workDir, name), { force: true });
    rmSync(path.join(paths.src, name), { force: true });
  }

  const durationMs = Date.now() - started;
  log('info', `Build completed in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    commit,
    framework: settings.framework,
    serveMode,
    startCommand: settings.startCommand,
    outputPath,
    functions,
    manifest,
    durationMs,
  };
}

/** Removes a deployment's directory from disk. */
export function removeDeploymentDir(deploymentId: string): void {
  const { dir } = deploymentPaths(deploymentId);
  rmSync(dir, { recursive: true, force: true });
}
