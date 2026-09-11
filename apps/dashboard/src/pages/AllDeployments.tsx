import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Deployment } from '../api.ts';
import { Duration, EmptyState, Spinner, StatusBadge, TimeAgo } from '../components/ui.tsx';

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

/** The `/deployments` tab of the home shell: every deployment, across every project. */
export function AllDeployments() {
  const [deployments, setDeployments] = useState<Deployment[] | null>(null);
  const [project, setProject] = useState('');
  const [env, setEnv] = useState<EnvFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [branch, setBranch] = useState('');

  const load = useCallback(async () => {
    const { deployments: rows } = await api.deployments(150);
    setDeployments(rows);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the list live while builds are running, anywhere in the workspace.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as Deployment;
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
  }, []);

  const projects = useMemo(
    () =>
      Array.from(
        new Map(
          (deployments ?? [])
            .filter((d) => d.projectSlug)
            .map((d) => [d.projectSlug as string, d.projectName ?? d.projectSlug!])
        ).entries()
      ).sort((a, b) => a[1].localeCompare(b[1])),
    [deployments]
  );

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
        if (project && d.projectSlug !== project) return false;
        if (env !== 'all' && d.target !== env) return false;
        if (status !== 'all' && !STATUS_MATCH[status].includes(d.state)) return false;
        if (branch && d.branch !== branch) return false;
        return true;
      }),
    [deployments, project, env, status, branch]
  );

  const clearable = Boolean(project) || env !== 'all' || status !== 'all' || Boolean(branch);

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
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All</option>
            {projects.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        </label>

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
              setProject('');
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
              deployments.length ? undefined : 'Import a project to see its deployments here.'
            }
          />
        ) : (
          <div className="dep-list">
            {filtered.map((deployment) => (
              <Link
                key={deployment.id}
                className="dep-row wide"
                to={`/projects/${deployment.projectSlug}/deployments/${deployment.id}`}
              >
                <span className="dep-project ellipsis">
                  {deployment.projectName ?? deployment.projectSlug}
                </span>

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
