import { deployments, events, projects } from '@avail/db';
import { removeDeploymentDir, runBuild, type BuildPhase } from '@avail/builder';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import type { Deployment, Project } from '@avail/shared/types';
import { bus } from '../lib/bus.ts';
import { github } from '../lib/github.ts';
import { appendLog, logSink, releaseLogCounter } from './logs.ts';

const log = createLogger('queue');

const PHASE_STATE: Partial<Record<BuildPhase, Deployment['state']>> = {
  initializing: 'INITIALIZING',
  cloning: 'INITIALIZING',
  installing: 'BUILDING',
  building: 'BUILDING',
  collecting: 'UPLOADING',
  publishing: 'UPLOADING',
};

function publish(deployment: Deployment): void {
  bus.publishDeployment({
    deploymentId: deployment.id,
    projectId: deployment.project_id,
    state: deployment.state,
    deployment,
  });
}

/**
 * Serial-with-concurrency build queue. Builds run in this process as child
 * shell commands, so logs stream live to dashboard clients over SSE.
 */
class BuildQueue {
  private pending: string[] = [];
  private running = new Map<string, AbortController>();
  /** Projects with a build in flight; one build per project at a time. */
  private runningProjects = new Set<string>();
  private draining = false;

  get status() {
    return {
      pending: this.pending.length,
      running: [...this.running.keys()],
      concurrency: config.build.concurrency,
    };
  }

  enqueue(deploymentId: string): void {
    if (this.running.has(deploymentId) || this.pending.includes(deploymentId)) {
      return;
    }
    this.pending.push(deploymentId);
    queueMicrotask(() => this.drain());
  }

  isRunning(deploymentId: string): boolean {
    return this.running.has(deploymentId);
  }

  /**
   * Picks up deployments no in-process caller `enqueue()`d — rows the Rust
   * API (or anything else) inserted directly as `QUEUED`. `enqueue()`
   * already dedupes against what's pending/running, so calling this
   * repeatedly is safe; it is also what `recoverOnBoot()` already did for
   * crash recovery, just widened from "once at startup" to "every tick."
   * See docs/rust-api-migration-plan.md.
   */
  private pickUpExternallyQueued(): void {
    for (const deployment of deployments.queued()) {
      this.enqueue(deployment.id);
    }
  }

  /**
   * Cross-process cancellation: `cancel()` below can abort an
   * `AbortController` directly when the request lands in this same
   * process, but the Rust API cannot reach into this process's memory. For
   * a build already running, it instead flags the deployment's `meta` JSON
   * (`cancelRequested: true`) and this notices it here, same effect either
   * way — the build's `AbortController` gets aborted.
   */
  private checkCancelFlags(): void {
    for (const [id, controller] of this.running) {
      if (controller.signal.aborted) continue;
      const deployment = deployments.byId(id);
      if (!deployment?.meta) continue;
      try {
        const meta = JSON.parse(deployment.meta) as { cancelRequested?: boolean };
        if (meta.cancelRequested) controller.abort();
      } catch {
        /* malformed meta — nothing to act on */
      }
    }
  }

  private pollTimer: NodeJS.Timeout | null = null;

  /** Starts the background pickup/cancellation poll. Idempotent. */
  startPolling(intervalMs = 1000): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pickUpExternallyQueued();
      this.checkCancelFlags();
    }, intervalMs);
    this.pollTimer.unref();
  }

  /** Cancels a running or pending build. */
  cancel(deploymentId: string): boolean {
    const controller = this.running.get(deploymentId);
    if (controller) {
      controller.abort();
      return true;
    }
    const index = this.pending.indexOf(deploymentId);
    if (index !== -1) {
      this.pending.splice(index, 1);
      const deployment = deployments.setState(deploymentId, 'CANCELED', {
        error: 'Canceled before the build started',
      });
      if (deployment) publish(deployment);
      return true;
    }
    return false;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (
        this.running.size < config.build.concurrency &&
        this.pending.length > 0
      ) {
        // Builds of one project share its workspace, so they must not run
        // concurrently. Look past a blocked project to a different one.
        const index = this.pending.findIndex((id) => {
          const projectId = deployments.byId(id)?.project_id;
          return !projectId || !this.runningProjects.has(projectId);
        });
        if (index === -1) break;

        const id = this.pending.splice(index, 1)[0];
        const projectId = deployments.byId(id)?.project_id;
        const controller = new AbortController();
        this.running.set(id, controller);
        if (projectId) this.runningProjects.add(projectId);

        void this.execute(id, controller)
          .catch((err) => log.error(`Build ${id} crashed:`, err))
          .finally(() => {
            this.running.delete(id);
            if (projectId) this.runningProjects.delete(projectId);
            releaseLogCounter(id);
            queueMicrotask(() => this.drain());
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(
    deploymentId: string,
    controller: AbortController
  ): Promise<void> {
    const deployment = deployments.byId(deploymentId);
    if (!deployment) return;
    if (deployment.state === 'CANCELED') return;

    const project = projects.byId(deployment.project_id);
    if (!project) {
      deployments.setState(deploymentId, 'ERROR', {
        error: 'Project no longer exists',
      });
      return;
    }

    const started = Date.now();
    let current =
      deployments.setState(deploymentId, 'INITIALIZING', {
        building_at: started,
      }) ?? deployment;
    publish(current);

    const { envForDeployment, gitTokenFor, assignAliases, urlFor } = await import(
      './deployments.ts'
    );

    await this.reportGitStatus(project, current, 'pending').catch(() => {});

    try {
      const result = await runBuild({
        deployment: current,
        project,
        env: envForDeployment(project.id, current.target, current.branch),
        gitToken: gitTokenFor(project),
        repoUrl: project.repo_provider === 'local' ? project.repo_full_name : null,
        log: logSink(deploymentId),
        signal: controller.signal,
        onPhase: (phase) => {
          const state = PHASE_STATE[phase];
          if (!state || state === current.state) return;
          current = deployments.setState(deploymentId, state) ?? current;
          publish(current);
        },
      });

      const ready = deployments.update(deploymentId, {
        state: 'READY',
        framework: result.framework,
        serve_mode: result.serveMode,
        start_command: result.startCommand,
        output_path: result.outputPath,
        ready_at: Date.now(),
        build_duration_ms: result.durationMs,
        commit_sha: result.commit.sha,
        commit_message: current.commit_message ?? result.commit.message,
        commit_author: current.commit_author ?? result.commit.author,
        error: null,
      })!;

      // Remember what detection found so the dashboard and later builds
      // start from the resolved framework instead of re-detecting blind.
      if (!project.framework && result.framework) {
        projects.update(project.id, {
          framework: result.framework,
          serve_mode: result.serveMode,
        });
      }

      const assigned = assignAliases(ready, project);
      appendLog(
        deploymentId,
        'info',
        `Deployment ready: ${assigned.map((host) => urlFor(host)).join('  ')}`
      );

      const final = deployments.byId(deploymentId)!;
      publish(final);
      events.record({
        type: 'deployment.ready',
        project_id: project.id,
        deployment_id: deploymentId,
        text: `Deployment ready at ${urlFor(final.url)}`,
      });

      await this.reportGitStatus(project, final, 'success').catch(() => {});
      await this.commentOnPullRequest(project, final).catch(() => {});
      this.cleanupOldDeployments(project);
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = (err as Error).message || 'Build failed';
      appendLog(deploymentId, 'error', message);

      const failed = deployments.update(deploymentId, {
        state: aborted ? 'CANCELED' : 'ERROR',
        error: message,
        build_duration_ms: Date.now() - started,
        ready_at: null,
      })!;
      publish(failed);

      events.record({
        type: aborted ? 'deployment.canceled' : 'deployment.error',
        project_id: project.id,
        deployment_id: deploymentId,
        text: message,
      });

      await this.reportGitStatus(
        project,
        failed,
        aborted ? 'error' : 'failure'
      ).catch(() => {});
    }
  }

  /** Mirrors the deployment state onto the GitHub commit status API. */
  private async reportGitStatus(
    project: Project,
    deployment: Deployment,
    state: 'pending' | 'success' | 'failure' | 'error'
  ): Promise<void> {
    if (
      !project.repo_full_name ||
      project.repo_provider !== 'github' ||
      !deployment.commit_sha
    ) {
      return;
    }
    const { gitTokenFor } = await import('./deployments.ts');
    const token = gitTokenFor(project);
    if (!token) return;

    const description =
      state === 'success'
        ? 'Deployment ready'
        : state === 'pending'
          ? 'Build in progress'
          : (deployment.error ?? 'Deployment failed').slice(0, 138);

    await github.createCommitStatus(
      token,
      project.repo_full_name,
      deployment.commit_sha,
      {
        state,
        description,
        target_url: `${config.dashboardUrl}/projects/${project.slug}/deployments/${deployment.id}`,
        context:
          deployment.target === 'production'
            ? 'avail/production'
            : 'avail/preview',
      }
    );
  }

  /** Posts the preview URL as a comment on the originating pull request. */
  private async commentOnPullRequest(
    project: Project,
    deployment: Deployment
  ): Promise<void> {
    if (!deployment.pr_number || !project.repo_full_name) return;
    const { gitTokenFor, urlFor } = await import('./deployments.ts');
    const token = gitTokenFor(project);
    if (!token) return;

    const body = [
      '**Avail Deploy** — preview ready :rocket:',
      '',
      '| Name | Status | Preview | Updated |',
      '| :--- | :----- | :------ | :------ |',
      `| ${project.name} | Ready | [Visit](${urlFor(deployment.url)}) | ${new Date().toUTCString()} |`,
    ].join('\n');

    await github.commentOnPullRequest(
      token,
      project.repo_full_name,
      deployment.pr_number,
      body
    );
  }

  /** Frees disk by dropping build artifacts of superseded deployments. */
  private cleanupOldDeployments(project: Project): void {
    const stale = deployments.staleForProject(
      project.id,
      config.build.keepPerProject
    );
    for (const deployment of stale) {
      if (!deployment.output_path) continue;
      try {
        removeDeploymentDir(deployment.id);
        deployments.update(deployment.id, { output_path: null });
        log.debug(`Pruned artifacts for ${deployment.id}`);
      } catch (err) {
        log.warn(`Could not prune ${deployment.id}:`, (err as Error).message);
      }
    }
  }

  /**
   * Recovers deployments that were mid-flight when the API restarted:
   * queued builds resume, in-progress builds are marked as failed.
   */
  recoverOnBoot(): void {
    for (const deployment of deployments.active()) {
      if (deployment.state === 'QUEUED') {
        this.enqueue(deployment.id);
        continue;
      }
      const failed = deployments.update(deployment.id, {
        state: 'ERROR',
        error: 'Build interrupted by a platform restart',
      });
      if (failed) publish(failed);
    }
  }
}

export const queue = new BuildQueue();
