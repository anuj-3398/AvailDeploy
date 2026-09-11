import { projects, repoWatch } from '@avail/db';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import type { Project } from '@avail/shared/types';
import { github } from '../lib/github.ts';
import { createDeployment, gitTokenFor } from './deployments.ts';

const log = createLogger('poller');

/**
 * Polls connected repositories for new commits.
 *
 * Webhooks are the primary trigger, but they need a publicly reachable URL.
 * Polling keeps auto-deploys working on a laptop or an internal network.
 */
class RepoPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;

  start(): void {
    if (!config.github.pollEnabled || this.timer) return;
    log.info(
      `Polling connected repositories every ${Math.round(
        config.github.pollIntervalMs / 1000
      )}s`
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, config.github.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get status() {
    return {
      enabled: config.github.pollEnabled,
      intervalMs: config.github.pollIntervalMs,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    };
  }

  /** Runs one polling pass across every auto-deploy project. */
  async tick(): Promise<{ checked: number; triggered: number }> {
    if (this.running) return { checked: 0, triggered: 0 };
    this.running = true;
    let checked = 0;
    let triggered = 0;

    try {
      for (const project of projects.withAutoDeploy()) {
        if (project.repo_provider !== 'github') continue;
        try {
          checked++;
          triggered += await this.checkProject(project);
        } catch (err) {
          this.lastError = `${project.slug}: ${(err as Error).message}`;
          log.warn(this.lastError);
        }
      }
      this.lastRunAt = Date.now();
    } finally {
      this.running = false;
    }
    return { checked, triggered };
  }

  private async checkProject(project: Project): Promise<number> {
    const token = gitTokenFor(project);
    if (!token || !project.repo_full_name) return 0;

    const branches = await github.branches(token, project.repo_full_name);
    const tracked = new Map(
      repoWatch.forProject(project.id).map((row) => [row.branch, row.last_sha])
    );
    let triggered = 0;

    for (const branch of branches) {
      const isProduction = branch.name === project.production_branch;
      if (!isProduction && !project.preview_deploys) continue;

      const known = tracked.get(branch.name);
      if (known === branch.commit.sha) continue;

      repoWatch.set(project.id, branch.name, branch.commit.sha);

      // First sighting of a branch only records its head; we deploy on change.
      if (known === undefined) continue;

      const head = await github.branchHead(
        token,
        project.repo_full_name,
        branch.name
      );

      createDeployment({
        project,
        target: isProduction ? 'production' : 'preview',
        source: 'git',
        branch: branch.name,
        commitSha: branch.commit.sha,
        commitMessage: head?.message ?? null,
        commitAuthor: head?.author ?? null,
        commitUrl: head?.url ?? null,
        meta: { trigger: 'poll' },
      });
      triggered++;
      log.info(
        `New commit on ${project.repo_full_name}@${branch.name} — deployment queued`
      );
    }

    return triggered;
  }

  /** Records current branch heads so the first poll does not deploy them all. */
  async seed(project: Project): Promise<void> {
    const token = gitTokenFor(project);
    if (!token || !project.repo_full_name) return;
    try {
      const branches = await github.branches(token, project.repo_full_name);
      for (const branch of branches) {
        repoWatch.set(project.id, branch.name, branch.commit.sha);
      }
    } catch (err) {
      log.warn(`Could not seed branches for ${project.slug}:`, (err as Error).message);
    }
  }
}

export const poller = new RepoPoller();
