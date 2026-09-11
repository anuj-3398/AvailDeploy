import type { FastifyInstance, FastifyReply } from 'fastify';
import { buildLogs, deployments, projects } from '@avail/db';
import { removeDeploymentDir } from '@avail/builder';
import { TERMINAL_STATES } from '@avail/shared/types';
import { HttpError, requireAuth, resolveUser } from '../lib/auth.ts';
import { bus } from '../lib/bus.ts';
import {
  createDeployment,
  promoteToProduction,
  serializeDeployment,
} from '../services/deployments.ts';
import { queue } from '../services/queue.ts';

function requireDeployment(id: string) {
  const deployment = deployments.byId(id);
  if (!deployment) throw new HttpError(404, 'Deployment not found', 'not_found');
  return deployment;
}

/** Opens an SSE stream on the raw response. */
function openStream(reply: FastifyReply): (event: string, data: unknown) => void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event: string, data: unknown) => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export async function deploymentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: string } }>(
    '/api/deployments',
    { preHandler: requireAuth },
    async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 25) || 25, 100);
      return {
        deployments: deployments.recent(limit).map(serializeDeployment),
      };
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/deployments/:id',
    { preHandler: requireAuth },
    async (request) => {
      const deployment = requireDeployment(request.params.id);
      return {
        deployment: serializeDeployment(deployment),
        isBuilding: queue.isRunning(deployment.id),
      };
    }
  );

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/deployments/:id/logs',
    { preHandler: requireAuth },
    async (request) => {
      const deployment = requireDeployment(request.params.id);
      const since = Number(request.query.since ?? -1);
      const logs = buildLogs.forDeployment(
        deployment.id,
        Number.isFinite(since) ? since : -1
      );
      return {
        state: deployment.state,
        logs: logs.map((l) => ({
          seq: l.seq,
          ts: l.ts,
          level: l.level,
          text: l.text,
        })),
      };
    }
  );

  /**
   * Live build output. Replays existing logs, then streams new lines and
   * state changes until the deployment reaches a terminal state.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/deployments/:id/events',
    async (request, reply) => {
      // EventSource cannot set headers, so authenticate from the cookie.
      const user = resolveUser(request);
      if (!user) throw new HttpError(401, 'Authentication required', 'unauthorized');

      const deployment = requireDeployment(request.params.id);
      const send = openStream(reply);

      const since = Number(request.query.since ?? -1);
      for (const line of buildLogs.forDeployment(
        deployment.id,
        Number.isFinite(since) ? since : -1
      )) {
        send('log', {
          seq: line.seq,
          ts: line.ts,
          level: line.level,
          text: line.text,
        });
      }
      send('state', { state: deployment.state });

      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
      }, 20_000);

      const offLog = bus.onLog(deployment.id, (event) =>
        send('log', {
          seq: event.seq,
          ts: event.ts,
          level: event.level,
          text: event.text,
        })
      );

      const close = () => {
        clearInterval(heartbeat);
        offLog();
        offState();
        if (!reply.raw.writableEnded) reply.raw.end();
      };

      const offState = bus.onDeployment(deployment.id, (event) => {
        send('state', {
          state: event.state,
          deployment: serializeDeployment(event.deployment),
        });
        if (TERMINAL_STATES.includes(event.state)) {
          send('done', { state: event.state });
          setTimeout(close, 250);
        }
      });

      request.raw.on('close', close);

      // Already finished before the client connected.
      if (TERMINAL_STATES.includes(deployment.state)) {
        send('done', { state: deployment.state });
        setTimeout(close, 250);
      }
    }
  );

  /** Dashboard-wide activity stream. */
  app.get('/api/events', async (request, reply) => {
    const user = resolveUser(request);
    if (!user) throw new HttpError(401, 'Authentication required', 'unauthorized');

    const send = openStream(reply);
    send('ready', { ok: true });

    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 20_000);

    const off = bus.onAnyDeployment((event) =>
      send('deployment', serializeDeployment(event.deployment))
    );

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      off();
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });

  app.post<{ Params: { id: string } }>(
    '/api/deployments/:id/cancel',
    { preHandler: requireAuth },
    async (request) => {
      const deployment = requireDeployment(request.params.id);
      if (TERMINAL_STATES.includes(deployment.state)) {
        throw new HttpError(
          400,
          `Deployment is already ${deployment.state}`,
          'not_cancelable'
        );
      }
      const canceled = queue.cancel(deployment.id);
      return { ok: canceled, deployment: serializeDeployment(deployments.byId(deployment.id)!) };
    }
  );

  /** Promote a preview to production, which is also how rollback works. */
  app.post<{ Params: { id: string } }>(
    '/api/deployments/:id/promote',
    { preHandler: requireAuth },
    async (request) => {
      const deployment = requireDeployment(request.params.id);
      const project = projects.byId(deployment.project_id);
      if (!project) throw new HttpError(404, 'Project not found', 'not_found');
      if (deployment.state !== 'READY') {
        throw new HttpError(
          400,
          'Only a READY deployment can be promoted',
          'not_ready'
        );
      }
      if (!deployment.output_path) {
        throw new HttpError(
          410,
          'This deployment’s build artifacts have been pruned. Redeploy it instead.',
          'artifacts_pruned'
        );
      }

      const assigned = promoteToProduction(deployment, project, request.user!.id);
      return {
        ok: true,
        domains: assigned,
        deployment: serializeDeployment(deployments.byId(deployment.id)!),
      };
    }
  );

  /** Rebuild the same commit as a new deployment. */
  app.post<{ Params: { id: string }; Body: { target?: 'production' | 'preview' } }>(
    '/api/deployments/:id/redeploy',
    { preHandler: requireAuth },
    async (request, reply) => {
      const source = requireDeployment(request.params.id);
      const project = projects.byId(source.project_id);
      if (!project) throw new HttpError(404, 'Project not found', 'not_found');

      const deployment = createDeployment({
        project,
        target: request.body?.target ?? source.target,
        source: 'redeploy',
        branch: source.branch,
        commitSha: source.commit_sha,
        commitMessage: source.commit_message,
        commitAuthor: source.commit_author,
        commitUrl: source.commit_url,
        prNumber: source.pr_number,
        createdBy: request.user!.id,
        meta: { redeployOf: source.id },
      });

      reply.code(202);
      return { deployment: serializeDeployment(deployment) };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/deployments/:id',
    { preHandler: requireAuth },
    async (request) => {
      const deployment = requireDeployment(request.params.id);
      if (deployment.is_current_production) {
        throw new HttpError(
          400,
          'Cannot delete the current production deployment',
          'is_production'
        );
      }
      queue.cancel(deployment.id);
      try {
        removeDeploymentDir(deployment.id);
      } catch {
        /* already gone */
      }
      deployments.delete(deployment.id);
      return { ok: true };
    }
  );
}
