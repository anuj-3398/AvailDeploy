import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { getDb, loginCodes, sessions } from '@avail/db';
import { config, dataDirIsNested } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import { HttpError } from './lib/auth.ts';
import { authRoutes } from './routes/auth.ts';
import { deploymentRoutes } from './routes/deployments.ts';
import { envRoutes } from './routes/env.ts';
import { gitRoutes } from './routes/git.ts';
import { projectRoutes } from './routes/projects.ts';
import { systemRoutes } from './routes/system.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { poller } from './services/poller.ts';
import { queue } from './services/queue.ts';

const log = createLogger('api');

function ensureDirectories(): void {
  for (const dir of [
    config.dataDir,
    config.workspaceDir,
    config.projectsDir,
    config.deploymentsDir,
    config.cacheDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export async function createServer() {
  ensureDirectories();
  getDb();

  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin requests (no Origin header) and the dashboard are allowed.
      if (!origin) return callback(null, true);
      const allowed = [
        config.dashboardUrl,
        config.apiUrl,
        `http://localhost:${config.dashboardPort}`,
        `http://127.0.0.1:${config.dashboardPort}`,
      ];
      callback(null, allowed.includes(origin));
    },
    credentials: true,
  });

  await app.register(cookie, { secret: config.secret });

  app.setErrorHandler((rawError, request, reply) => {
    if (rawError instanceof HttpError) {
      return reply
        .code(rawError.statusCode)
        .send({ error: { code: rawError.code, message: rawError.message } });
    }

    const error = rawError as Error & { statusCode?: number; code?: string };
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      log.error(`${request.method} ${request.url}:`, error);
    }
    return reply.code(status).send({
      error: {
        code: error.code ?? 'internal_error',
        message: error.message || 'Something went wrong',
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${request.url}` },
    });
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(gitRoutes);
  await app.register(projectRoutes);
  await app.register(envRoutes);
  await app.register(deploymentRoutes);
  await app.register(webhookRoutes);

  return app;
}

export async function start(): Promise<void> {
  const app = await createServer();

  queue.recoverOnBoot();
  poller.start();

  const cleanup = setInterval(() => {
    sessions.purgeExpired();
    loginCodes.purgeExpired();
  }, 60 * 60 * 1000);
  cleanup.unref();

  await app.listen({ port: config.apiPort, host: config.host });

  log.info(`API listening on http://${config.host}:${config.apiPort}`);
  log.info(`Sign-in restricted to: ${config.allowedEmailDomains.map((d) => `@${d}`).join(', ')}`);
  log.info(`Build executor: ${config.build.executor}`);
  log.info(`Data directory: ${config.dataDir}`);
  log.info(`Build workspace: ${config.workspaceDir} (${config.workspaceReason})`);
  if (config.build.executor === 'wsl' && !config.workspaceIsNative) {
    log.warn(
      'Builds run on a Windows drive mounted into WSL. Every dependency file ' +
        'crosses the 9p bridge, which dominates build time.'
    );
  }
  if (dataDirIsNested()) {
    log.warn(
      'AVAIL_DATA_DIR is inside the platform repository. Builds will inherit ' +
        "the platform's node_modules and npm workspace — move it outside."
    );
  }

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down`);
    poller.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isEntrypoint || process.env.AVAIL_START === '1') {
  start().catch((err) => {
    log.error('Failed to start API:', err);
    process.exit(1);
  });
}
