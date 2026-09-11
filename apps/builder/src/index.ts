import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

export { capture, checkExecutor, kill, run } from './executor.ts';
export { toWslPath, execPath, shQuote } from './paths.ts';

export type BuildPhase =
  | 'initializing'
  | 'cloning'
  | 'installing'
  | 'building'
  | 'collecting'
  | 'publishing'
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

/** Directory layout for one published deployment. */
export function deploymentPaths(deploymentId: string) {
  const dir = path.join(config.deploymentsDir, deploymentId);
  return {
    dir,
    src: path.join(dir, 'src'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

/**
 * Long-lived build workspace for a project, reused by every build.
 *
 * Keeping the checkout, `node_modules` and the framework cache between builds
 * turns a cold install into an incremental one — the single biggest win on a
 * self-hosted builder. Builds of one project are serialized so they never
 * share this directory concurrently.
 */
export function projectWorkspace(projectId: string) {
  const dir = path.join(config.projectsDir, projectId);
  return {
    dir,
    src: path.join(dir, 'src'),
    /** Generated shell scripts, kept out of the git working tree. */
    scripts: path.join(dir, 'scripts'),
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

/**
 * Publishes the finished build as an immutable deployment directory.
 *
 * The copy is made with hard links (`cp -al`), so a 300 MB `node_modules`
 * snapshot costs directory entries rather than 300 MB and a few minutes of
 * I/O. Build tools replace files rather than rewriting them in place, so
 * earlier snapshots keep pointing at the bytes they were built from.
 *
 * `.next/cache` is excluded — it is scratch space that later builds do mutate
 * in place, and it is never served.
 */
async function snapshot(
  workDir: string,
  destDir: string,
  scriptDir: string,
  log: LogSink,
  signal: AbortSignal
): Promise<void> {
  const from = shQuote(execPath(workDir));
  const to = shQuote(execPath(destDir));

  const result = await run({
    command: [
      `rm -rf ${to}`,
      `mkdir -p ${to}`,
      // Hard-link the tree; fall back to a real copy on filesystems that
      // cannot link (a different device, or a non-GNU cp).
      `cp -al ${from}/. ${to}/ 2>/dev/null || cp -a ${from}/. ${to}/`,
      // Scratch and history are not part of the artifact.
      `rm -rf ${to}/.next/cache ${to}/.git ${to}/.turbo`,
    ].join('\n'),
    cwd: path.dirname(scriptDir),
    log: (level, text) => log(level === 'stdout' ? 'info' : level, text),
    signal,
    label: 'snapshot',
    scriptDir,
    timeoutMs: 10 * 60_000,
  });

  if (result.code !== 0) {
    throw new Error('Could not publish the build output');
  }
}

/**
 * Runs a complete deployment build: fetch source, resolve settings, install,
 * build, then collect the output into an immutable deployment directory.
 */
export async function runBuild(input: BuildInput): Promise<BuildOutput> {
  const { deployment, project, log, signal, onPhase } = input;
  const started = Date.now();
  const paths = deploymentPaths(deployment.id);
  const workspace = projectWorkspace(project.id);

  onPhase?.('initializing');
  const firstBuild = !existsSync(path.join(workspace.src, '.git'));
  mkdirSync(workspace.src, { recursive: true });
  mkdirSync(workspace.scripts, { recursive: true });

  log('info', `Deploying ${project.name} (${deployment.target})`);
  log(
    'info',
    `Build executor: ${config.build.executor}` +
      (config.build.executor === 'wsl'
        ? ` · workspace: ${config.workspaceIsNative ? 'WSL-native' : 'Windows drive (slow)'}`
        : '')
  );
  if (!firstBuild) {
    log('info', 'Reusing the project workspace (incremental install and cache)');
  }

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
    dir: workspace.src,
    token: input.gitToken,
    log,
    signal,
    scriptDir: workspace.scripts,
  });
  log('info', `Checked out ${commit.sha.slice(0, 7)} — ${commit.message}`);

  /* ------------------------------------------------------------ settings */
  const rootConfig = readProjectConfig(workspace.src);
  const resolved = resolveSettings({
    repoDir: workspace.src,
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
  if (settings.installCommand) {
    onPhase?.('installing');
    log(
      'info',
      existsSync(path.join(workDir, 'node_modules'))
        ? 'Installing dependencies (incremental)'
        : 'Installing dependencies'
    );
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
      scriptDir: workspace.scripts,
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
      scriptDir: workspace.scripts,
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

  /** Where a workspace path ends up inside the published deployment. */
  const inSnapshot = (abs: string): string => {
    const rel = path.relative(workspace.src, abs).split(path.sep).join('/');
    return rel ? `src/${rel}` : 'src';
  };

  const serveMode = settings.serveMode;
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
      staticDir = inSnapshot(workDir);
      log(
        'warn',
        `No output directory found${
          settings.outputDirectory ? ` at "${settings.outputDirectory}"` : ''
        } — serving the root directory`
      );
    } else {
      staticDir = inSnapshot(path.join(workDir, outputDirectory));
      log('info', `Output directory: ${outputDirectory}`);
    }
    outputPath = staticDir;
  } else {
    if (!settings.startCommand) {
      throw new Error(
        `Framework "${settings.framework}" needs a start command. Set "startCommand" in avail.json or add a "start" script.`
      );
    }
    outputPath = inSnapshot(workDir);
    log('info', `Serve mode: server (${settings.startCommand})`);
  }

  /* ------------------------------------------------------------ publish */
  onPhase?.('publishing');
  const snapshotStarted = Date.now();
  mkdirSync(paths.dir, { recursive: true });
  await snapshot(workspace.src, paths.src, workspace.scripts, log, signal);
  log(
    'info',
    `Published deployment artifacts in ${((Date.now() - snapshotStarted) / 1000).toFixed(1)}s`
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
    functionsDir: functions.length ? inSnapshot(workDir) : null,
    serverDir: inSnapshot(workDir),
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
