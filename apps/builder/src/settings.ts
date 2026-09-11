import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  SERVER_FRAMEWORKS,
  defaultInstallCommand,
  detectFramework,
  detectPackageManager,
  findOutputDirectory,
  getFramework,
  readPackageJson,
  runScriptCommand,
  type PackageManager,
} from '@avail/frameworks';
import type {
  Project,
  ProjectConfigFile,
  ResolvedBuildSettings,
  ServeMode,
} from '@avail/shared/types';

/** Config file names probed in the project root, in priority order. */
const CONFIG_FILES = ['avail.json', 'vercel.json'];

export function readProjectConfig(dir: string): ProjectConfigFile {
  for (const name of CONFIG_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as ProjectConfigFile;
    } catch (err) {
      throw new Error(`Invalid ${name}: ${(err as Error).message}`);
    }
  }
  return {};
}

/**
 * Default boot commands for frameworks served as a long-lived process.
 * `$PORT` and `$HOST` are exported into the process environment.
 */
const START_COMMANDS: Record<string, string> = {
  nextjs: 'npx --no-install next start --port $PORT --hostname $HOST',
  blitzjs: 'npx --no-install blitz start --port $PORT',
  nuxtjs: 'node .output/server/index.mjs',
  nitro: 'node .output/server/index.mjs',
  sveltekit: 'node build/index.js',
  'sveltekit-1': 'node build/index.js',
  remix: 'npx --no-install remix-serve ./build/server/index.js',
  'react-router': 'npx --no-install react-router-serve ./build/server/index.js',
  'solidstart-1': 'node .output/server/index.mjs',
  solidstart: 'node .output/server/index.mjs',
  hydrogen: 'npx --no-install shopify hydrogen preview --port $PORT',
  'tanstack-start': 'node .output/server/index.mjs',
  nestjs: 'node dist/main.js',
  redwoodjs: 'npx --no-install rw serve --port $PORT',
};

function hasScript(pkg: Record<string, any> | null, name: string): boolean {
  return Boolean(pkg?.scripts?.[name]);
}

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** Absolute path of the checked-out repository. */
  repoDir: string;
  project: Project;
  /** Config file already read from the resolved root directory. */
  configFile?: ProjectConfigFile;
}

/**
 * Merges framework preset, `avail.json`/`vercel.json` and project overrides
 * into the concrete commands used for a build. Project settings win, then the
 * config file, then the detected framework's defaults.
 */
export function resolveSettings(options: ResolveOptions): {
  settings: ResolvedBuildSettings;
  configFile: ProjectConfigFile;
  workDir: string;
  packageManager: PackageManager;
  detectedFramework: string | null;
} {
  const { repoDir, project } = options;

  const rootDirectory =
    project.root_directory?.trim() ||
    options.configFile?.rootDirectory?.trim() ||
    '.';
  const workDir = path.resolve(repoDir, rootDirectory);
  if (!dirExists(workDir)) {
    throw new Error(`Root directory "${rootDirectory}" does not exist in the repository`);
  }

  const configFile = options.configFile ?? readProjectConfig(workDir);
  const pkg = readPackageJson(workDir);
  const packageManager = detectPackageManager(workDir);

  const detected = detectFramework(workDir);
  const frameworkSlug =
    project.framework ?? configFile.framework ?? detected?.slug ?? null;
  const preset = getFramework(frameworkSlug);

  const installCommand =
    project.install_command ??
    configFile.installCommand ??
    preset?.settings.installCommand ??
    (pkg ? defaultInstallCommand(packageManager) : null);

  // Vercel's rule: a `build` script in package.json wins over the preset.
  const presetBuild = preset?.settings.buildCommand ?? null;
  const buildCommand =
    project.build_command ??
    configFile.buildCommand ??
    (hasScript(pkg, 'build')
      ? runScriptCommand(packageManager, 'build')
      : presetBuild);

  const serveMode: ServeMode =
    (project.serve_mode as ServeMode | null) ??
    configFile.serveMode ??
    (frameworkSlug && SERVER_FRAMEWORKS.has(frameworkSlug) ? 'server' : 'static');

  let outputDirectory: string | null =
    project.output_directory ??
    configFile.outputDirectory ??
    preset?.settings.outputDirectory ??
    null;

  const startCommand =
    serveMode === 'server'
      ? (configFile.startCommand ??
        (frameworkSlug ? START_COMMANDS[frameworkSlug] : null) ??
        (hasScript(pkg, 'start')
          ? runScriptCommand(packageManager, 'start')
          : null))
      : null;

  return {
    settings: {
      framework: frameworkSlug,
      rootDirectory,
      installCommand,
      buildCommand,
      outputDirectory,
      devCommand:
        project.dev_command ??
        configFile.devCommand ??
        preset?.settings.devCommand ??
        null,
      serveMode,
      startCommand,
      nodeVersion: project.node_version || '22.x',
    },
    configFile,
    workDir,
    packageManager,
    detectedFramework: detected?.slug ?? null,
  };
}

/**
 * Resolves the static output directory after the build has run, probing the
 * usual candidates when the framework did not declare one.
 */
export function resolveOutputDirectory(
  workDir: string,
  declared: string | null,
  frameworkSlug: string | null
): string | null {
  if (declared) {
    const abs = path.resolve(workDir, declared);
    return dirExists(abs) ? declared : null;
  }

  const preset = getFramework(frameworkSlug);
  const presetDefault = preset?.defaultOutputDirName;
  if (presetDefault && dirExists(path.join(workDir, presetDefault))) {
    return presetDefault;
  }

  // A Next.js static export lands in `out/`.
  if (frameworkSlug === 'nextjs' && dirExists(path.join(workDir, 'out'))) {
    return 'out';
  }

  return findOutputDirectory(workDir);
}
