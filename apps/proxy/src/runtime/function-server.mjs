/**
 * Serverless function host for one deployment.
 *
 * Spawned by the proxy inside the deployment's working directory. It loads
 * handlers lazily on first request and supports both the Node-style
 * `(req, res)` signature and the Web-standard `(Request) => Response` one.
 *
 * Written as plain ESM so it runs on any Node >= 20 without a loader.
 */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.AVAIL_RUNTIME_PORT || 0);
const WORKDIR = process.env.AVAIL_WORKDIR || process.cwd();
const ROUTES = JSON.parse(process.env.AVAIL_FUNCTIONS || '[]');
const DEFAULT_TIMEOUT = Number(process.env.AVAIL_FUNCTION_TIMEOUT || 60) * 1000;

const moduleCache = new Map();

/** `/api/users/[id]` vs `/api/users/42` */
function matchRoute(route, pathname) {
  const routeParts = route.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  const params = {};

  for (let i = 0; i < routeParts.length; i++) {
    const part = routeParts[i];
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(part);
    if (catchAll) {
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

function resolveHandler(mod) {
  const candidate =
    mod?.default?.default ?? mod?.default ?? mod?.handler ?? mod?.GET ?? null;
  return typeof candidate === 'function' ? candidate : null;
}

async function loadHandler(file) {
  if (moduleCache.has(file)) return moduleCache.get(file);
  const url = pathToFileURL(path.resolve(WORKDIR, file)).href;
  const mod = await import(url);
  const handler = resolveHandler(mod);
  if (!handler) {
    throw new Error(`${file} does not export a request handler`);
  }
  moduleCache.set(file, handler);
  return handler;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType = '') {
  if (!raw.length) return undefined;
  const text = raw.toString('utf8');
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(
      part.slice(index + 1).trim()
    );
  }
  return cookies;
}

/** Adds the `res.status().json()` helpers that Vercel handlers expect. */
function decorateResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    if (!res.headersSent) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  res.send = (payload) => {
    if (payload === undefined || payload === null) return res.end();
    if (Buffer.isBuffer(payload) || typeof payload === 'string') {
      if (!res.headersSent && !res.getHeader('content-type')) {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      return res.end(payload);
    }
    return res.json(payload);
  };
  res.redirect = (statusOrUrl, maybeUrl) => {
    const status = typeof statusOrUrl === 'number' ? statusOrUrl : 307;
    const location = typeof statusOrUrl === 'number' ? maybeUrl : statusOrUrl;
    res.statusCode = status;
    res.setHeader('location', location);
    return res.end();
  };
  return res;
}

async function sendWebResponse(res, webResponse) {
  res.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  if (!webResponse.body) return res.end();
  const buffer = Buffer.from(await webResponse.arrayBuffer());
  res.end(buffer);
}

function toWebRequest(req, raw) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody && raw.length ? raw : undefined,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/__avail/health') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true, routes: ROUTES.length }));
  }

  const entry = ROUTES.map((route) => ({
    route,
    params: matchRoute(route.route, url.pathname),
  })).find((candidate) => candidate.params !== null);

  if (!entry) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({ error: `No function matches ${url.pathname}` })
    );
  }

  const timeoutMs = (entry.route.maxDuration || 0) * 1000 || DEFAULT_TIMEOUT;
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.statusCode = 504;
      res.end(
        JSON.stringify({
          error: `Function ${entry.route.route} timed out after ${timeoutMs / 1000}s`,
        })
      );
    }
  }, timeoutMs);

  try {
    const handler = await loadHandler(entry.route.file);
    const raw = await readBody(req);

    // Zero- or one-argument handlers use the Web Request/Response signature.
    if (handler.length <= 1) {
      const webResponse = await handler(toWebRequest(req, raw), {
        params: entry.params,
      });
      clearTimeout(timer);
      if (webResponse instanceof Response) {
        return await sendWebResponse(res, webResponse);
      }
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(webResponse ?? null));
    }

    req.query = {
      ...Object.fromEntries(url.searchParams),
      ...entry.params,
    };
    req.cookies = parseCookies(req.headers.cookie);
    req.body = parseBody(raw, req.headers['content-type'] || '');
    decorateResponse(res);

    await handler(req, res);
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  } catch (err) {
    clearTimeout(timer);
    process.stderr.write(
      `[function] ${entry.route.route} failed: ${err && err.stack ? err.stack : err}\n`
    );
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'FUNCTION_INVOCATION_FAILED',
          message: err instanceof Error ? err.message : String(err),
        })
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address();
  process.stdout.write(
    `[function-runtime] listening on ${typeof address === 'object' ? address.port : PORT}\n`
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
