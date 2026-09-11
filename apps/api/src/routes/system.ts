import type { FastifyInstance } from 'fastify';
import { deployments, events, get, projects, users } from '@avail/db';
import { checkExecutor } from '@avail/builder';
import { frameworks } from '@avail/frameworks';
import { config } from '@avail/shared/config';
import { requireAuth } from '../lib/auth.ts';
import { poller } from '../services/poller.ts';
import { queue } from '../services/queue.ts';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'avail-api',
    time: Date.now(),
  }));

  /** Static platform facts the dashboard needs before sign-in. */
  app.get('/api/system/info', async () => ({
    name: 'Avail Deploy',
    allowedDomains: config.allowedEmailDomains,
    deploymentDomain: config.deploymentDomain,
    proxyPort: config.proxyPort,
    dashboardUrl: config.dashboardUrl,
    apiUrl: config.apiUrl,
    buildExecutor: config.build.executor,
    githubOAuth: Boolean(config.github.clientId),
    webhookUrl: `${config.apiUrl}/api/webhooks/github`,
  }));

  app.get('/api/frameworks', async () => ({
    frameworks: frameworks
      .filter((f) => !f.experimental && f.slug)
      .map((f) => ({
        slug: f.slug,
        name: f.name,
        logo: f.logo,
        buildCommand: f.settings.buildCommand,
        installCommand: f.settings.installCommand,
        outputDirectory: f.settings.outputDirectory ?? f.defaultOutputDirName,
        devCommand: f.settings.devCommand,
      })),
  }));

  app.get('/api/system/status', { preHandler: requireAuth }, async () => {
    const executor = await checkExecutor();
    return {
      queue: queue.status,
      poller: poller.status,
      executor: {
        kind: config.build.executor,
        distro: config.build.wslDistro,
        ok: executor.ok,
        detail: executor.detail,
      },
      counts: {
        projects: projects.list().length,
        users: users.count(),
        deployments:
          get<{ c: number }>('SELECT COUNT(*) AS c FROM deployments')?.c ?? 0,
      },
    };
  });

  app.get('/api/system/overview', { preHandler: requireAuth }, async () => {
    const allProjects = projects.list();
    const recent = deployments.recent(10);
    return {
      projects: allProjects.length,
      deployments: recent.length,
      building: queue.status.running.length,
      activity: events.recent(20),
    };
  });

  /** Force an immediate poll of all connected repositories. */
  app.post('/api/system/poll', { preHandler: requireAuth }, async () => {
    const result = await poller.tick();
    return { ok: true, ...result };
  });
}
