import { existsSync, readFileSync, statSync } from 'node:fs';
import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { aliases, deployments, getDb, projects, requestLogs } from '@avail/db';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import { ensureSelfSignedCert } from './tls.ts';
import type {
  Deployment,
  DeploymentManifest,
  Project,
} from '@avail/shared/types';
import {
  extraHeaders,
  findRedirect,
  findRewrite,
  matchFunctionRoute,
} from './routing.ts';
import { runtimes } from './runtime.ts';
import { errorPage, escapeHtml, sendNotFound, serveStatic } from './static.ts';

const log = createLogger('proxy');

/* --------------------------------------------------------------- manifests */

interface CachedManifest {
  manifest: DeploymentManifest;
  mtimeMs: number;
}
const manifestCache = new Map<string, CachedManifest>();

function deploymentDir(deploymentId: string): string {
  return path.join(config.deploymentsDir, deploymentId);
}

function loadManifest(deploymentId: string): DeploymentManifest | null {
  const file = path.join(deploymentDir(deploymentId), 'manifest.json');
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }

  const cached = manifestCache.get(deploymentId);
  if (cached && cached.mtimeMs === stats.mtimeMs) return cached.manifest;

  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as DeploymentManifest;
    manifestCache.set(deploymentId, { manifest, mtimeMs: stats.mtimeMs });
    return manifest;
  } catch (err) {
    log.error(`Invalid manifest for ${deploymentId}:`, err);
    return null;
  }
}

/* ---------------------------------------------------------------- routing */

interface Resolved {
  deployment: Deployment;
  project: Project | null;
  /** Path prefix to strip before serving (path-based access). */
  basePath: string;
}

function hostname(req: IncomingMessage): string {
  const host = (req.headers.host ?? '').toLowerCase();
  return host.split(':')[0];
}

/** Maps an incoming request to the deployment that should serve it. */
function resolveTarget(req: IncomingMessage, pathname: string): Resolved | null {
  // Path-based access works on any host: /_d/<deploymentId>/...
  const pathMatch = /^\/_d\/([a-z0-9_]+)(\/.*)?$/.exec(pathname);
  if (pathMatch) {
    const deployment = deployments.byId(pathMatch[1]);
    if (!deployment) return null;
    return {
      deployment,
      project: projects.byId(deployment.project_id),
      basePath: `/_d/${pathMatch[1]}`,
    };
  }

  const host = hostname(req);
  const alias = aliases.byDomain(host);
  if (!alias) return null;

  let deployment = alias.deployment_id
    ? deployments.byId(alias.deployment_id)
    : null;

  // A project-level alias with no pinned deployment follows production.
  if (!deployment && alias.project_id) {
    deployment = deployments.currentProduction(alias.project_id);
  }
  if (!deployment) return null;

  return {
    deployment,
    project: projects.byId(deployment.project_id),
    basePath: '',
  };
}

/* -------------------------------------------------------------- responses */

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {}
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(html);
}

/** Shown while a deployment is still building; refreshes itself. */
function buildingPage(deployment: Deployment): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Deployment building</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#000;color:#fff}
  .card{max-width:460px;padding:32px;text-align:center}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#f5a623;margin-right:8px;
       animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;opacity:.6}
  h1{font-size:18px;font-weight:600;margin:0 0 8px}
  p{opacity:.7;margin:0 0 16px}
</style></head><body><div class="card">
<h1><span class="dot"></span>Deployment in progress</h1>
<p>This deployment is <strong>${escapeHtml(deployment.state)}</strong>. The page reloads automatically.</p>
<code>${escapeHtml(deployment.id)}</code>
</div></body></html>`;
}

/** Landing page served on the proxy's own hostname. */
function indexPage(): string {
  const rows = projects
    .list()
    .map((project) => {
      const production = deployments.currentProduction(project.id);
      const host = `${project.slug}.${config.deploymentDomain}`;
      const url = `${config.deploymentScheme}://${host}:${config.proxyPort}`;
      return `<tr>
        <td><a href="${url}">${escapeHtml(project.name)}</a></td>
        <td><code>${escapeHtml(host)}</code></td>
        <td>${production ? escapeHtml(production.id) : '<em>not deployed</em>'}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avail Deploy — Edge</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;padding:48px 24px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#000;color:#fff}
  main{max-width:760px;margin:0 auto}
  h1{font-size:20px;margin:0 0 4px}
  p.sub{opacity:.6;margin:0 0 28px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #222}
  th{opacity:.5;font-weight:500;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
  a{color:#3291ff;text-decoration:none}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;opacity:.75}
  .empty{opacity:.5;padding:32px 0}
</style></head><body><main>
<h1>Avail Deploy — Edge Network</h1>
<p class="sub">Requests are routed to deployments by hostname. Dashboard: <a href="${config.dashboardUrl}">${config.dashboardUrl}</a></p>
${
  rows
    ? `<table><thead><tr><th>Project</th><th>Production domain</th><th>Deployment</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">No projects yet.</div>'
}
</main></body></html>`;
}

/* ------------------------------------------------------------- proxying */

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  pathname: string,
  search: string,
  headers: Record<string, string> = {}
): void {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: `${pathname}${search}`,
      headers: {
        ...req.headers,
        host: req.headers.host ?? 'localhost',
        'x-forwarded-host': req.headers.host ?? '',
        'x-forwarded-proto': config.deploymentScheme,
        'x-forwarded-for': req.socket.remoteAddress ?? '',
      },
    },
    (upstreamRes) => {
      res.statusCode = upstreamRes.statusCode ?? 502;
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) res.setHeader(key, value as string | string[]);
      }
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }
      upstreamRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    log.error('Upstream error:', err.message);
    if (!res.headersSent) {
      sendHtml(
        res,
        502,
        errorPage(502, 'The deployment runtime is not responding.', err.message)
      );
    } else {
      res.end();
    }
  });

  req.pipe(upstream);
}

/* --------------------------------------------------------------- handler */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const host = hostname(req);

  if (url.pathname === '/_avail/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, runtimes: runtimes.running }));
    return;
  }

  const target = resolveTarget(req, url.pathname);

  if (!target) {
    const isPlatformHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === config.deploymentDomain;
    if (isPlatformHost && url.pathname === '/') {
      sendHtml(res, 200, indexPage());
      return;
    }
    sendHtml(
      res,
      404,
      errorPage(
        404,
        'No deployment is assigned to this domain.',
        `${host}${url.pathname}`
      )
    );
    return;
  }

  const { deployment, project, basePath } = target;

  const span = trace(req);
  span.projectId = deployment.project_id;
  span.deploymentId = deployment.id;

  const baseHeaders: Record<string, string> = {
    'x-avail-id': deployment.id,
    'x-avail-target': deployment.target,
    server: 'avail',
  };

  if (deployment.state !== 'READY') {
    span.kind = 'error';
    span.message =
      deployment.state === 'ERROR' || deployment.state === 'CANCELED'
        ? (deployment.error ?? 'Deployment failed to build')
        : `Deployment is ${deployment.state}`;
    if (deployment.state === 'ERROR' || deployment.state === 'CANCELED') {
      sendHtml(
        res,
        502,
        errorPage(
          502,
          'This deployment failed to build.',
          deployment.error ?? deployment.id
        ),
        baseHeaders
      );
      return;
    }
    sendHtml(res, 503, buildingPage(deployment), {
      ...baseHeaders,
      'retry-after': '5',
    });
    return;
  }

  const manifest = loadManifest(deployment.id);
  if (!manifest) {
    span.kind = 'error';
    span.message = 'Build artifacts are no longer available';
    sendHtml(
      res,
      502,
      errorPage(
        502,
        'This deployment’s build artifacts are no longer available.',
        'Redeploy the project to restore it.'
      ),
      baseHeaders
    );
    return;
  }

  // Strip the /_d/<id> prefix used for path-based access.
  let pathname = basePath
    ? url.pathname.slice(basePath.length) || '/'
    : url.pathname;
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const projectConfig = manifest.config ?? {};
  const responseHeaders = {
    ...baseHeaders,
    ...extraHeaders(projectConfig.headers, pathname),
  };

  /* redirects */
  const redirect = findRedirect(projectConfig.redirects, pathname, url.search);
  if (redirect) {
    span.kind = 'redirect';
    span.message = `-> ${redirect.location}`;
    res.statusCode = redirect.statusCode;
    res.setHeader('location', basePath + redirect.location);
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value);
    }
    res.end();
    return;
  }

  /* rewrites */
  const rewritten = findRewrite(projectConfig.rewrites, pathname);
  if (rewritten) pathname = rewritten.split('?')[0];

  const dir = deploymentDir(deployment.id);

  /* server-mode deployments proxy everything to the framework server */
  if (manifest.serveMode === 'server') {
    span.kind = 'server';
    try {
      const instance = await runtimes.acquire(
        deployment.id,
        dir,
        manifest,
        'server'
      );
      instance.lastUsedAt = Date.now();
      proxyRequest(req, res, instance.port, pathname, url.search, responseHeaders);
    } catch (err) {
      span.kind = 'error';
      span.message = firstLine(err);
      log.error(`Could not start runtime for ${deployment.id}:`, err);
      sendHtml(
        res,
        502,
        errorPage(
          502,
          'The deployment failed to start.',
          (err as Error).message.split('\n')[0]
        ),
        responseHeaders
      );
    }
    return;
  }

  /* serverless functions */
  const fn = manifest.functions.find(
    (entry) => matchFunctionRoute(entry.route, pathname) !== null
  );
  if (fn) {
    span.kind = 'function';
    try {
      const instance = await runtimes.acquire(
        deployment.id,
        dir,
        manifest,
        'functions',
        fn
      );
      instance.lastUsedAt = Date.now();
      proxyRequest(req, res, instance.port, pathname, url.search, responseHeaders);
    } catch (err) {
      span.kind = 'error';
      span.message = firstLine(err);
      log.error(`Function runtime failed for ${deployment.id}:`, err);
      sendHtml(
        res,
        502,
        errorPage(
          502,
          'The function runtime failed to start.',
          (err as Error).message.split('\n')[0]
        ),
        responseHeaders
      );
    }
    return;
  }

  /* static assets */
  const staticRoot = manifest.staticDir
    ? path.resolve(dir, manifest.staticDir)
    : null;

  if (staticRoot && existsSync(staticRoot)) {
    const result = serveStatic(
      req,
      res,
      staticRoot,
      pathname,
      projectConfig,
      responseHeaders
    );
    if (result.handled) return;

    // Single-page apps fall back to index.html when there is no 404 page.
    const hasCustom404 = existsSync(path.join(staticRoot, '404.html'));
    const indexFile = path.join(staticRoot, 'index.html');
    const accepts = String(req.headers.accept ?? '').includes('text/html');
    if (!hasCustom404 && accepts && existsSync(indexFile) && pathname !== '/') {
      serveStatic(req, res, staticRoot, '/', projectConfig, responseHeaders);
      return;
    }

    sendNotFound(req, res, staticRoot, pathname);
    return;
  }

  sendHtml(
    res,
    404,
    errorPage(404, 'Nothing is deployed at this path.', pathname),
    responseHeaders
  );
}

/* ---------------------------------------------------------------- server */

/**
 * Per-request context the handler fills in so the access log can attribute the
 * request to a project and say how it was served.
 */
interface RequestTrace {
  projectId: string | null;
  deploymentId: string | null;
  kind: string;
  message: string | null;
  /** Guards against the double signal from `finish` + `close`. */
  recorded?: boolean;
}

const traces = new WeakMap<IncomingMessage, RequestTrace>();

/** Error messages can carry a captured log tail; the log column wants one line. */
function firstLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split(/\r?\n/)[0];
}

function trace(req: IncomingMessage): RequestTrace {
  let value = traces.get(req);
  if (!value) {
    value = {
      projectId: null,
      deploymentId: null,
      kind: 'static',
      message: null,
    };
    traces.set(req, value);
  }
  return value;
}

/** Prune every so often rather than on every request. */
let requestsSincePrune = 0;
const PRUNE_EVERY = 200;
const KEEP_PER_PROJECT = 2000;

function recordRequest(
  req: IncomingMessage,
  res: ServerResponse,
  startedAt: number
): void {
  const current = traces.get(req);
  if (!current?.projectId) return; // Platform routes and unmatched hosts.
  if (current.recorded) return;
  current.recorded = true;

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    requestLogs.record({
      project_id: current.projectId,
      deployment_id: current.deploymentId,
      ts: startedAt,
      method: req.method ?? 'GET',
      host: hostname(req),
      path: url.pathname + url.search,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      kind: current.kind,
      message: current.message,
    });

    if (++requestsSincePrune >= PRUNE_EVERY) {
      requestsSincePrune = 0;
      requestLogs.prune(current.projectId, KEEP_PER_PROJECT);
    }
  } catch (err) {
    // Never let logging break a response, but do not drop it silently either.
    log.warn('Could not record request log:', (err as Error).message);
  }
}

/** Shared by both the HTTP and HTTPS listeners — same routing either way. */
function requestListener(req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  // `finish` does not fire for every response shape (a piped file stream is
  // one), while `close` always does — and also covers a client that hangs
  // up mid-response. recordRequest de-duplicates the two.
  const done = () => {
    log.debug(
      `${req.method} ${hostname(req)}${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`
    );
    recordRequest(req, res, started);
  };
  res.on('finish', done);
  res.on('close', done);
  handle(req, res).catch((err) => {
    log.error('Unhandled proxy error:', err);
    if (!res.headersSent) {
      sendHtml(res, 500, errorPage(500, 'Internal proxy error.', String(err)));
    } else if (!res.writableEnded) {
      res.end();
    }
  });
}

export function createProxyServer() {
  getDb();
  return http.createServer(requestListener);
}

/**
 * A second listener on `config.proxyHttpsPort`, terminating TLS with a
 * self-signed certificate — see `tls.ts` for what this is and isn't.
 * Returns `null` (proxy stays HTTP-only) if `openssl` isn't available.
 */
export function createProxyHttpsServer(): https.Server | null {
  const tls = ensureSelfSignedCert();
  if (!tls) return null;
  return https.createServer(tls, requestListener);
}

export function start(): void {
  const server = createProxyServer();
  server.listen(config.proxyPort, '0.0.0.0', () => {
    log.info(`Proxy listening on http://localhost:${config.proxyPort}`);
    log.info(`Deployment domains: *.${config.deploymentDomain}:${config.proxyPort}`);
  });

  const httpsServer = createProxyHttpsServer();
  httpsServer?.listen(config.proxyHttpsPort, '0.0.0.0', () => {
    log.info(`Proxy also listening on https://localhost:${config.proxyHttpsPort} (self-signed)`);
  });

  const shutdown = () => {
    log.info('Shutting down runtimes');
    runtimes.stopAll();
    server.close(() => process.exit(0));
    httpsServer?.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) start();
