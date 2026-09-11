import { createReadStream, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { ProjectConfigFile } from '@avail/shared/types';
import { cacheControl, contentType } from './mime.ts';

export interface StaticResult {
  handled: boolean;
  /** Set when the request resolved to a file that does not exist. */
  notFound?: boolean;
}

function statFile(file: string): Stats | null {
  try {
    const stats = statSync(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/** Candidate files for a request path, in the order Vercel resolves them. */
export function resolveCandidates(
  pathname: string,
  cleanUrls: boolean
): string[] {
  const trimmed = pathname.replace(/\/+$/, '');
  const candidates: string[] = [];

  if (pathname === '/' || trimmed === '') {
    return ['index.html'];
  }

  const relative = trimmed.replace(/^\/+/, '');
  const hasExtension = path.extname(relative) !== '';

  candidates.push(relative);
  if (!hasExtension) {
    candidates.push(`${relative}.html`);
    candidates.push(`${relative}/index.html`);
    if (cleanUrls) candidates.push(`${relative}.htm`);
  }
  return candidates;
}

/** True when `child` stays inside `root` after symlink-free resolution. */
function isInside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function etagFor(stats: Stats): string {
  return `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
}

/**
 * Serves a file from `root` for `pathname`. Returns `handled: false` when no
 * candidate file exists so the caller can fall back to functions or a 404.
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
  projectConfig: ProjectConfigFile,
  extraResponseHeaders: Record<string, string> = {}
): StaticResult {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }

  for (const candidate of resolveCandidates(decoded, projectConfig.cleanUrls ?? false)) {
    const file = path.resolve(root, candidate);
    if (!isInside(root, file)) continue;

    const stats = statFile(file);
    if (!stats) continue;

    sendFile(req, res, file, stats, decoded, extraResponseHeaders);
    return { handled: true };
  }

  return { handled: false, notFound: true };
}

export function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  stats: Stats,
  pathname: string,
  extraResponseHeaders: Record<string, string> = {},
  statusCode = 200
): void {
  const ext = path.extname(file);
  const etag = etagFor(stats);

  res.setHeader('content-type', contentType(ext));
  res.setHeader('cache-control', cacheControl(pathname, ext));
  res.setHeader('etag', etag);
  res.setHeader('last-modified', stats.mtime.toUTCString());
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('x-avail-cache', 'MISS');
  for (const [key, value] of Object.entries(extraResponseHeaders)) {
    res.setHeader(key, value);
  }

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    res.statusCode = statusCode;
    res.setHeader('content-length', String(stats.size));
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, stats.size);
  if (range) {
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${stats.size}`);
    res.setHeader('content-length', String(range.end - range.start + 1));
    createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.statusCode = statusCode;
  res.setHeader('content-length', String(stats.size));
  createReadStream(file).pipe(res);
}

function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!header?.startsWith('bytes=')) return null;
  const [startRaw, endRaw] = header.slice(6).split('-');
  let start = startRaw ? Number(startRaw) : NaN;
  let end = endRaw ? Number(endRaw) : NaN;

  if (Number.isNaN(start) && !Number.isNaN(end)) {
    start = Math.max(size - end, 0);
    end = size - 1;
  } else if (!Number.isNaN(start) && Number.isNaN(end)) {
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

/** Serves `404.html` when present, otherwise a plain platform 404 page. */
export function sendNotFound(
  req: IncomingMessage,
  res: ServerResponse,
  root: string | null,
  pathname: string
): void {
  if (root) {
    const custom = path.resolve(root, '404.html');
    const stats = statFile(custom);
    if (stats && isInside(root, custom)) {
      sendFile(req, res, custom, stats, pathname, {}, 404);
      return;
    }
  }
  res.statusCode = 404;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(errorPage(404, 'This page could not be found.', pathname));
}

/** Minimal branded error page used for platform-level errors. */
export function errorPage(
  status: number,
  message: string,
  detail?: string
): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:#fff; color:#000; }
  @media (prefers-color-scheme: dark) { body { background:#000; color:#fff; } }
  .box { display:flex; align-items:center; gap:20px; }
  .code { font-size:24px; font-weight:600; padding-right:20px; border-right:1px solid rgba(128,128,128,.4); }
  .msg { font-size:14px; opacity:.85; }
  .detail { margin-top:6px; font-size:12px; opacity:.55; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
</style></head>
<body><div class="box">
  <div class="code">${status}</div>
  <div><div class="msg">${escapeHtml(message)}</div>${
    detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ''
  }</div>
</div></body></html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char
  );
}
