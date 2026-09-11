import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import frameworksData from './frameworks.json' with { type: 'json' };

export interface DetectionItem {
  path?: string;
  matchPackage?: string;
  matchContent?: string;
}

export interface FrameworkPreset {
  name: string;
  slug: string;
  logo?: string | null;
  envPrefix?: string | null;
  /** Vercel runtime the framework maps to; used here as a serving hint. */
  useRuntime?: string | null;
  detectors: { every?: DetectionItem[]; some?: DetectionItem[] };
  settings: {
    installCommand: string | null;
    buildCommand: string | null;
    devCommand: string | null;
    outputDirectory: string | null;
  };
  defaultOutputDirName?: string | null;
  cachePattern?: string | null;
  supersedes?: string[] | null;
  experimental?: boolean;
  runtimeFramework?: boolean;
}

export const frameworks: FrameworkPreset[] =
  frameworksData as unknown as FrameworkPreset[];

const bySlug = new Map(frameworks.map((f) => [f.slug, f]));

export function getFramework(slug: string | null | undefined) {
  return slug ? (bySlug.get(slug) ?? null) : null;
}

/**
 * Frameworks whose output is a long-lived HTTP server rather than a folder of
 * static assets. These are booted as a managed process behind the proxy.
 */
export const SERVER_FRAMEWORKS = new Set([
  'nextjs',
  'blitzjs',
  'nuxtjs',
  'remix',
  'react-router',
  'redwoodjs',
  'sveltekit',
  'sveltekit-1',
  'solidstart',
  'solidstart-1',
  'nitro',
  'nestjs',
  'express',
  'fastify',
  'koa',
  'hono',
  'h3',
  'elysia',
  'hydrogen',
  'tanstack-start',
  'tanstack-start-lovable',
  'node',
  'bun',
  'container',
  'mastra',
  'xmcp',
]);

/** Output directories probed when a framework declares none. */
export const DEFAULT_OUTPUT_CANDIDATES = [
  'dist',
  'build',
  'out',
  'public',
  '_site',
  'output',
  '.output/public',
];

function readFileSafe(file: string): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function checkItem(
  dir: string,
  slug: string,
  item: DetectionItem
): { matched: boolean; version?: string } {
  let { path: filePath, matchContent, matchPackage } = item;
  if (!filePath) filePath = 'package.json';

  const abs = path.join(dir, filePath);
  if (!existsSync(abs)) return { matched: false };

  if (matchPackage) {
    matchContent = `"(dev)?(d|D)ependencies":\\s*{[^}]*"${matchPackage.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    )}":\\s*"(.+?)"[^}]*}`;
  }

  if (matchContent) {
    const content = readFileSafe(abs);
    if (content === null) return { matched: false };
    const match = content.match(new RegExp(matchContent, 'm'));
    if (!match) return { matched: false };
    return { matched: true, version: matchPackage ? match[3] : undefined };
  }

  return { matched: true };
}

export interface DetectionResult {
  slug: string;
  name: string;
  version?: string;
  preset: FrameworkPreset;
}

/**
 * Detects the framework used by the project rooted at `dir`, mirroring
 * Vercel's `detect-framework` algorithm (every/some detectors + supersedes).
 */
export function detectFramework(dir: string): DetectionResult | null {
  const matched: { preset: FrameworkPreset; version?: string }[] = [];

  for (const preset of frameworks) {
    if (preset.experimental) continue;
    const { every, some } = preset.detectors ?? {};
    if (!every?.length && !some?.length) continue;

    let version: string | undefined;
    let ok = true;

    for (const item of every ?? []) {
      const res = checkItem(dir, preset.slug, item);
      if (!res.matched) {
        ok = false;
        break;
      }
      version ??= res.version;
    }

    if (ok && some?.length) {
      const hit = some
        .map((item) => checkItem(dir, preset.slug, item))
        .find((r) => r.matched);
      if (!hit) ok = false;
      else version ??= hit.version;
    }

    if (ok) matched.push({ preset, version });
  }

  if (matched.length === 0) return null;

  // A framework that supersedes another wins (e.g. SvelteKit over Vite).
  const superseded = new Set<string>();
  for (const m of matched) {
    for (const s of m.preset.supersedes ?? []) superseded.add(s);
  }
  const winner =
    matched.find((m) => !superseded.has(m.preset.slug)) ?? matched[0];

  return {
    slug: winner.preset.slug,
    name: winner.preset.name,
    version: winner.version,
    preset: winner.preset,
  };
}

/** Picks the first existing directory from a list of candidates. */
export function findOutputDirectory(dir: string): string | null {
  for (const candidate of DEFAULT_OUTPUT_CANDIDATES) {
    const abs = path.join(dir, candidate);
    try {
      if (statSync(abs).isDirectory()) return candidate;
    } catch {
      /* not present */
    }
  }
  return null;
}

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

/** Infers the package manager from the lockfile present in `dir`. */
export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock')))
    return 'bun';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Default install command for a package manager. Dev dependencies are forced
 * on: build tooling almost always lives there, and package managers omit them
 * when `NODE_ENV=production`.
 */
export function defaultInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --no-frozen-lockfile --prod=false';
    case 'yarn':
      return 'yarn install --production=false';
    case 'bun':
      return 'bun install';
    default:
      return 'npm install --no-audit --no-fund --include=dev';
  }
}

/** `npm run build`, `pnpm run build`, ... */
export function runScriptCommand(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

export function readPackageJson(dir: string): Record<string, any> | null {
  const content = readFileSafe(path.join(dir, 'package.json'));
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
