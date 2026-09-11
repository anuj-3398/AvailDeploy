import path from 'node:path';
import { config } from '@avail/shared/config';

/**
 * Converts a Windows path to the path WSL sees.
 *
 *   `D:\Projects\my-app\data`                ->  `/mnt/d/Projects/my-app/data`
 *   `\\wsl.localhost\Ubuntu\home\me\data`    ->  `/home/me/data`
 *
 * The UNC form matters for performance: a build on the WSL-native filesystem
 * installs dependencies several times faster than one on a `/mnt` drive mount,
 * so `AVAIL_DATA_DIR` can point at `\\wsl.localhost\<distro>\home\<user>\...`.
 */
export function toWslPath(winPath: string): string {
  const raw = String(winPath).replace(/\\/g, '/');

  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/.exec(raw);
  if (unc) return unc[1] || '/';

  const normalized = path.resolve(winPath).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!drive) return normalized;
  return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
}

/**
 * Path as the build executor sees it: WSL builds address Windows paths
 * through `/mnt/<drive>`, local builds use the path as-is.
 */
export function execPath(p: string): string {
  return config.build.executor === 'wsl' ? toWslPath(p) : p;
}

/** Quotes a value for safe interpolation into a POSIX shell script. */
export function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
