import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, type Deployment, type Project } from '../api.ts';
import { Duration, EmptyState, Spinner, StatusBadge, TimeAgo } from '../components/ui.tsx';

interface Context {
  project: Project;
}

type EnvFilter = 'all' | 'production' | 'preview';
type StatusFilter = 'all' | 'ready' | 'error' | 'building';

const STATUS_MATCH: Record<Exclude<StatusFilter, 'all'>, Deployment['state'][]> = {
  ready: ['READY'],
  error: ['ERROR', 'CANCELED'],
  building: ['QUEUED', 'INITIALIZING', 'BUILDING', 'UPLOADING'],
};

function authorLabel(deployment: Deployment): string {
  const author = deployment.commit?.author ?? '';
  const name = author.replace(/\s*<[^>]*>\s*$/, '').trim();
  return name || deployment.source;
}

function initials(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

export function ProjectDeployments() {
  const { project } = useOutletContext<Context>();
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [env, setEnv] = useState<EnvFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [branch, setBranch] = useState('');

  const load = useCallback(async () => {
    const { deployments: rows } = await api.projectDeployments(project.slug, 100);
    setDeployments(rows);
  }, [project.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the list live while builds are running.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as Deployment;
      if (updated.projectSlug !== project.slug) return;
      setDeployments((current) => {
        if (!current) return current;
        const index = current.findIndex((d) => d.id === updated.id);
        if (index === -1) return [updated, ...current];
        const next = [...current];
        next[index] = updated;
        return next;
      });
    });
    return () => source.close();
  }, [project.slug]);

  const branches = useMemo(
    () =>
      Array.from(
        new Set((deployments ?? []).map((d) => d.branch).filter(Boolean) as string[])
      ).sort(),
    [deployments]
  );

  const filtered = useMemo(
    () =>
      (deployments ?? []).filter((d) => {
        if (env !== 'all' && d.target !== env) return false;
        if (status !== 'all' && !STATUS_MATCH[status].includes(d.state)) return false;
        if (branch && d.branch !== branch) return false;
        return true;
      }),
    [deployments, env, status, branch]
  );

  const clearable = env !== 'all' || status !== 'all' || Boolean(branch);

  return (
    <>
      <div className="page-title">
        <h1>Deployments</h1>
        <div className="spacer" />
        <span className="small faint">
          {filtered.length}
          {filtered.length !== (deployments?.length ?? 0)
            ? ` of ${deployments?.length ?? 0}`
            : ''}
        </span>
      </div>

      <div className="filter-bar">
        <span className="filter-label">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M2 4h12M4.5 8h7M7 12h2"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Filter
        </span>

        <label className="chip">
          Environment
          <select value={env} onChange={(e) => setEnv(e.target.value as EnvFilter)}>
            <option value="all">All</option>
            <option value="production">Production</option>
            <option value="preview">Preview</option>
          </select>
        </label>

        <label className="chip">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="all">All</option>
            <option value="ready">Ready</option>
            <option value="building">Building</option>
            <option value="error">Error</option>
          </select>
        </label>

        <label className="chip">
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            <option value="">All</option>
            {branches.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>

        {clearable ? (
          <button
            className="btn sm ghost"
            onClick={() => {
              setEnv('all');
              setStatus('all');
              setBranch('');
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      <section className="panel">
        {deployments === null ? (
          <div className="panel-body">
            <Spinner label="Loading deployments…" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title={deployments.length ? 'No deployments match these filters' : 'No deployments yet'}
            description={
              deployments.length
                ? undefined
                : 'Push to the repository, or deploy from the Overview tab.'
            }
          />
        ) : (
          <div className="dep-list">
            {filtered.map((deployment) => (
              <Link
                key={deployment.id}
                className="dep-row"
                to={`/projects/${project.slug}/deployments/${deployment.id}`}
              >
                <span className="dep-message ellipsis">
                  {deployment.commit?.message ?? deployment.branch ?? deployment.id}
                </span>

                <span className="dep-status">
                  <StatusBadge state={deployment.state} />
                  <span className="faint small">
                    <Duration ms={deployment.buildDurationMs} />
                  </span>
                </span>

                <span
                  className={`env-badge${deployment.isCurrentProduction ? ' live' : ''}`}
                >
                  {deployment.target === 'production' ? (
                    <>
                      <span className="glyph" aria-hidden>
                        ⬆
                      </span>
                      Production
                    </>
                  ) : (
                    <>
                      <span className="glyph" aria-hidden>
                        ◉
                      </span>
                      Preview
                    </>
                  )}
                </span>

                <span className="dep-commit mono faint">
                  {deployment.commit ? `◦ ${deployment.commit.shortSha}` : '—'}
                </span>

                <span className="dep-branch mono faint ellipsis">
                  ⎇ {deployment.branch ?? '—'}
                </span>

                <span className="dep-time faint small">
                  <TimeAgo value={deployment.createdAt} />
                </span>

                <span className="avatar tiny" aria-hidden title={authorLabel(deployment)}>
                  {initials(authorLabel(deployment))}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
