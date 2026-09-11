import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, type Deployment, type Project } from '../api.ts';
import {
  Alert,
  CommitLine,
  Duration,
  EmptyState,
  Spinner,
  StatusBadge,
  TargetBadge,
  TimeAgo,
} from '../components/ui.tsx';

export function ProjectPage() {
  const { slug = '' } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ project: p }, { deployments: d }] = await Promise.all([
        api.project(slug),
        api.projectDeployments(slug, 40),
      ]);
      setProject(p);
      setDeployments(d);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load project');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as Deployment;
      if (updated.projectSlug !== slug) return;
      setDeployments((current) => {
        const index = current.findIndex((d) => d.id === updated.id);
        if (index === -1) return [updated, ...current];
        const next = [...current];
        next[index] = updated;
        return next;
      });
      if (updated.isCurrentProduction) void load();
    });
    return () => source.close();
  }, [slug, load]);

  async function deployNow() {
    setBusy(true);
    setError('');
    try {
      await api.deploy(slug);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deployment failed');
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <div className="container">
        <Alert kind="error">{error}</Alert>
        {!error ? <Spinner label="Loading…" /> : null}
      </div>
    );
  }

  const production = project.productionDeployment;

  return (
    <div className="container wide">
      <div className="page-head">
        <div className="stack">
          <h1>{project.name}</h1>
          <span className="sub">
            {project.repo ? project.repo.fullName : 'no repository'} ·{' '}
            {project.framework ?? 'auto-detected framework'}
          </span>
        </div>
        <div className="spacer" />
        <a
          className="btn"
          href={project.productionUrl}
          target="_blank"
          rel="noreferrer"
        >
          Visit
        </a>
        <Link className="btn" to={`/projects/${slug}/settings`}>
          Settings
        </Link>
        <button className="btn primary" onClick={deployNow} disabled={busy}>
          {busy ? 'Queuing…' : 'Deploy'}
        </button>
      </div>

      <Alert kind="error">{error}</Alert>

      <div className="card">
        <div className="card-head">
          <h2>Production Deployment</h2>
          <div className="spacer" />
          {production ? <StatusBadge state={production.state} /> : null}
        </div>
        <div className="card-body">
          {production ? (
            <dl className="kv">
              <dt>Deployment</dt>
              <dd>
                <Link to={`/projects/${slug}/deployments/${production.id}`}>
                  {production.id}
                </Link>
              </dd>
              <dt>Domains</dt>
              <dd>
                {production.aliases.map((alias) => (
                  <div key={alias.domain}>
                    <a href={alias.url} target="_blank" rel="noreferrer">
                      {alias.domain}
                    </a>
                  </div>
                ))}
              </dd>
              <dt>Source</dt>
              <dd>
                {production.branch}
                {production.commit ? ` · ${production.commit.shortSha}` : ''}
                {production.commit?.message
                  ? ` · ${production.commit.message}`
                  : ''}
              </dd>
              <dt>Framework</dt>
              <dd>
                {production.framework ?? 'static'} ·{' '}
                {production.serveMode ?? 'static'} mode
              </dd>
              <dt>Built in</dt>
              <dd>
                <Duration ms={production.buildDurationMs} /> ·{' '}
                <TimeAgo value={production.readyAt} />
              </dd>
            </dl>
          ) : (
            <EmptyState
              title="Nothing in production yet"
              description="Deploy the production branch to publish this project."
              action={
                <button className="btn primary" onClick={deployNow}>
                  Deploy {project.productionBranch}
                </button>
              }
            />
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Deployments</h2>
          <div className="spacer" />
          <span className="small faint">{project.deploymentCount} total</span>
        </div>
        {deployments.length === 0 ? (
          <EmptyState title="No deployments yet" />
        ) : (
          <div className="list">
            {deployments.map((deployment) => (
              <div key={deployment.id} className="list-item">
                <StatusBadge state={deployment.state} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <CommitLine deployment={deployment} />
                </div>
                <TargetBadge deployment={deployment} />
                <span className="small faint" style={{ width: 90 }}>
                  <TimeAgo value={deployment.createdAt} />
                </span>
                <Link
                  className="btn sm"
                  to={`/projects/${slug}/deployments/${deployment.id}`}
                >
                  Details
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
