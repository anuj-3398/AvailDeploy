import type {
  HeaderRule,
  ProjectConfigFile,
  RedirectRule,
  RewriteRule,
} from '@avail/shared/types';

export interface RouteMatch {
  params: Record<string, string>;
}

/**
 * Compiles a Vercel-style source pattern (`/blog/:slug`, `/docs/:path*`,
 * `/api/(.*)`) into a RegExp.
 */
export function compilePattern(source: string): {
  regex: RegExp;
  keys: string[];
} {
  const keys: string[] = [];
  let pattern = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === ':') {
      const nameMatch = /^:([A-Za-z0-9_]+)([*+?])?/.exec(source.slice(index));
      if (nameMatch) {
        keys.push(nameMatch[1]);
        const modifier = nameMatch[2];
        if (modifier === '*') pattern += '(.*?)';
        else if (modifier === '+') pattern += '(.+?)';
        else if (modifier === '?') pattern += '([^/]*)';
        else pattern += '([^/]+)';
        index += nameMatch[0].length;
        continue;
      }
    }

    if (char === '(') {
      // Pass through a raw regex group, tracking it as a positional capture.
      let depth = 1;
      let end = index + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === '(') depth++;
        else if (source[end] === ')') depth--;
        end++;
      }
      keys.push(String(keys.length));
      pattern += source.slice(index, end);
      index = end;
      continue;
    }

    if (char === '*') {
      keys.push(String(keys.length));
      pattern += '(.*)';
      index++;
      continue;
    }

    pattern += char.replace(/[.+?^${}|[\]\\]/g, '\\$&');
    index++;
  }

  return { regex: new RegExp(`^${pattern}\\/?$`), keys };
}

export function matchPattern(
  source: string,
  pathname: string
): RouteMatch | null {
  const { regex, keys } = compilePattern(source);
  const match = regex.exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = {};
  keys.forEach((key, i) => {
    params[key] = match[i + 1] ?? '';
  });
  return { params };
}

/** Substitutes `:name` placeholders and `$1` groups in a destination. */
export function applyParams(
  destination: string,
  params: Record<string, string>
): string {
  return destination
    .replace(/:([A-Za-z0-9_]+)(\*|\+|\?)?/g, (whole, name: string) =>
      params[name] !== undefined ? params[name] : whole
    )
    .replace(/\$(\d+)/g, (whole, index: string) =>
      params[String(Number(index) - 1)] !== undefined
        ? params[String(Number(index) - 1)]
        : whole
    );
}

export interface RedirectResult {
  location: string;
  statusCode: number;
}

/** First matching redirect rule, if any. */
export function findRedirect(
  rules: RedirectRule[] | undefined,
  pathname: string,
  search: string
): RedirectResult | null {
  for (const rule of rules ?? []) {
    const match = matchPattern(rule.source, pathname);
    if (!match) continue;
    const destination = applyParams(rule.destination, match.params);
    return {
      location: destination + (destination.includes('?') ? '' : search),
      statusCode: rule.statusCode ?? (rule.permanent === false ? 307 : 308),
    };
  }
  return null;
}

/** First matching rewrite rule, if any. */
export function findRewrite(
  rules: RewriteRule[] | undefined,
  pathname: string
): string | null {
  for (const rule of rules ?? []) {
    const match = matchPattern(rule.source, pathname);
    if (!match) continue;
    return applyParams(rule.destination, match.params);
  }
  return null;
}

/** Headers contributed by matching `headers` rules. */
export function extraHeaders(
  rules: HeaderRule[] | undefined,
  pathname: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules ?? []) {
    if (!matchPattern(rule.source, pathname)) continue;
    for (const header of rule.headers) headers[header.key] = header.value;
  }
  return headers;
}

/**
 * Matches a request path against file-system function routes, supporting
 * `[param]` and `[...catchAll]` segments.
 */
export function matchFunctionRoute(
  route: string,
  pathname: string
): Record<string, string> | null {
  const routeParts = route.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < routeParts.length; i++) {
    const part = routeParts[i];
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(part);
    if (catchAll) {
      if (pathParts.length < i) return null;
      params[catchAll[1]] = pathParts.slice(i).join('/');
      return params;
    }
    const dynamic = /^\[(.+)\]$/.exec(part);
    const value = pathParts[i];
    if (value === undefined) return null;
    if (dynamic) {
      params[dynamic[1]] = decodeURIComponent(value);
      continue;
    }
    if (part !== value) return null;
  }

  return pathParts.length === routeParts.length ? params : null;
}

export function normalizeConfig(config: ProjectConfigFile): ProjectConfigFile {
  return {
    cleanUrls: config.cleanUrls ?? false,
    trailingSlash: config.trailingSlash,
    redirects: config.redirects ?? [],
    rewrites: config.rewrites ?? [],
    headers: config.headers ?? [],
    functions: config.functions ?? {},
  };
}
