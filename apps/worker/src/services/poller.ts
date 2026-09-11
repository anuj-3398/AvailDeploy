import { projects, repoWatch } from '@avail/db';
import { capture, execPath, shQuote } from '@avail/builder';
import { config } from '@avail/shared/config';
import { createLogger } from '@avail/shared/logger';
import type { Project } from '@avail/shared/types';
import { github } from '../lib/github.ts';
import { createDeployment, gitTokenFor } from './deployments.ts';

/** One branch tip, however it was discovered. */
interface BranchHead {
  branch: string;
  sha: string;
}

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
    const heads =
      project.repo_provider === 'github'
        ? await this.githubHeads(project)
        : await this.localHeads(project);
    if (!heads) return 0;

    const tracked = new Map(
      repoWatch.forProject(project.id).map((row) => [row.branch, row.last_sha])
    );
    // A project with nothing tracked yet has never been seeded (import failed,
    // or the repository was attached by hand). Record the current heads rather
    // than deploying every branch at once.
    const seeding = tracked.size === 0;
    let triggered = 0;

    for (const head of heads) {
      const isProduction = head.branch === project.production_branch;
      if (!isProduction && !project.preview_deploys) continue;

      const known = tracked.get(head.branch);
      if (known === head.sha) continue;

      repoWatch.set(project.id, head.branch, head.sha);
      if (seeding) continue;

      const details = await this.commitDetails(project, head);

      createDeployment({
        project,
        target: isProduction ? 'production' : 'preview',
        source: 'git',
        branch: head.branch,
        commitSha: head.sha,
        commitMessage: details.message,
        commitAuthor: details.author,
        commitUrl: details.url,
        meta: { trigger: known === undefined ? 'poll:new-branch' : 'poll' },
      });
      triggered++;
      log.info(
        `${known === undefined ? 'New branch' : 'New commit'} ` +
          `${project.repo_full_name}@${head.branch} — deployment queued`
      );
    }

    if (seeding && heads.length) {
      log.info(
        `Recorded ${heads.length} branch head(s) for ${project.slug}; ` +
          'changes from here on will deploy'
      );
    }

    return triggered;
  }

  private async githubHeads(project: Project): Promise<BranchHead[] | null> {
    const token = gitTokenFor(project);
    if (!token || !project.repo_full_name) return null;
    const branches = await github.branches(token, project.repo_full_name);
    return branches.map((b) => ({ branch: b.name, sha: b.commit.sha }));
  }

  /**
   * Branch heads of a repository reachable on this machine — a local path or
   * any git URL. `for-each-ref` reads the refs without cloning, so polling a
   * local directory costs one cheap git call.
   */
  private async localHeads(project: Project): Promise<BranchHead[] | null> {
    if (!project.repo_full_name) return null;
    const repo = execPath(project.repo_full_name.replace(/^file:\/\//, ''));

    const output = await capture({
      command: `git -C ${shQuote(repo)} for-each-ref --format='%(objectname) %(refname:short)' refs/heads/`,
      cwd: config.dataDir,
      scriptDir: config.cacheDir,
      label: 'poll',
      timeoutMs: 60_000,
    });

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { sha: line.slice(0, space), branch: line.slice(space + 1) };
      })
      .filter((head) => head.sha && head.branch);
  }

  /** Commit subject/author for a head that just changed. */
  private async commitDetails(
    project: Project,
    head: BranchHead
  ): Promise<{ message: string | null; author: string | null; url: string | null }> {
    if (project.repo_provider === 'github' && project.repo_full_name) {
      const token = gitTokenFor(project);
      if (!token) return { message: null, author: null, url: null };
      const detail = await github
        .branchHead(token, project.repo_full_name, head.branch)
        .catch(() => null);
      return {
        message: detail?.message ?? null,
        author: detail?.author ?? null,
        url: detail?.url ?? null,
      };
    }

    try {
      const repo = execPath(project.repo_full_name!.replace(/^file:\/\//, ''));
      const output = await capture({
        command: `git -C ${shQuote(repo)} log -1 --format='%an <%ae>%n%s' ${shQuote(head.sha)}`,
        cwd: config.dataDir,
        scriptDir: config.cacheDir,
        label: 'poll-commit',
        timeoutMs: 60_000,
      });
      const [author = '', ...rest] = output.split('\n');
      return { message: rest.join('\n').trim() || null, author: author.trim() || null, url: null };
    } catch {
      return { message: null, author: null, url: null };
    }
  }

  /** Records current branch heads so the first poll does not deploy them all. */
  async seed(project: Project): Promise<void> {
    try {
      const heads =
        project.repo_provider === 'github'
          ? await this.githubHeads(project)
          : await this.localHeads(project);
      for (const head of heads ?? []) {
        repoWatch.set(project.id, head.branch, head.sha);
      }
    } catch (err) {
      log.warn(`Could not seed branches for ${project.slug}:`, (err as Error).message);
    }
  }
}

export const poller = new RepoPoller();
