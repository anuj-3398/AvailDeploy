import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FunctionEntry } from '@avail/shared/types';
import { config } from '@avail/shared/config';

const FUNCTION_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts'];
const IGNORED_DIRS = new Set(['node_modules', '.git', '_middleware', '__tests__']);

/**
 * Discovers serverless functions under `<workDir>/api`, following Vercel's
 * file-system routing: `api/users/[id].ts` serves `/api/users/[id]`.
 */
export function discoverFunctions(
  workDir: string,
  functionsConfig: Record<string, { maxDuration?: number }> = {}
): FunctionEntry[] {
  const apiDir = path.join(workDir, 'api');
  const entries: FunctionEntry[] = [];

  const walk = (dir: string, prefix: string): void => {
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.startsWith('.') || item.startsWith('_')) continue;
      const abs = path.join(dir, item);
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (IGNORED_DIRS.has(item)) continue;
        walk(abs, `${prefix}/${item}`);
        continue;
      }
      const ext = path.extname(item);
      if (!FUNCTION_EXTENSIONS.includes(ext)) continue;
      if (/\.(test|spec|d)\.[cm]?ts$/.test(item)) continue;

      const base = item.slice(0, -ext.length);
      const route = base === 'index' ? prefix : `${prefix}/${base}`;
      const file = path.relative(workDir, abs).split(path.sep).join('/');
      const override = functionsConfig[file] ?? functionsConfig[`${file}`];

      entries.push({
        route: route || '/api',
        file,
        runtime: 'nodejs',
        maxDuration: override?.maxDuration ?? config.runtime.maxDurationSec,
      });
    }
  };

  try {
    if (statSync(apiDir).isDirectory()) walk(apiDir, '/api');
  } catch {
    return [];
  }

  // Static routes before dynamic ones, and longer paths before shorter.
  return entries.sort((a, b) => {
    const dynamicA = a.route.includes('[') ? 1 : 0;
    const dynamicB = b.route.includes('[') ? 1 : 0;
    if (dynamicA !== dynamicB) return dynamicA - dynamicB;
    const catchAllA = a.route.includes('[...') ? 1 : 0;
    const catchAllB = b.route.includes('[...') ? 1 : 0;
    if (catchAllA !== catchAllB) return catchAllA - catchAllB;
    return b.route.length - a.route.length;
  });
}
