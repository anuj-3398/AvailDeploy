import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Deployment, type LogLine } from '../api.ts';
import {
  Alert,
  Duration,
  Spinner,
  StatusBadge,
  TargetBadge,
  TimeAgo,
} from '../components/ui.tsx';

const ACTIVE_STATES = ['QUEUED', 'INITIALIZING', 'BUILDING', 'UPLOADING'];

export function DeploymentPage() {
  const { slug = '', id = '' } = useParams();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [follow, setFollow] = useState(true);
  const logBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .deployment(id)
      .then(({ deployment: d }) => setDeployment(d))
      .catch((err: ApiError) => setError(err.message));
  }, [id]);

  /** Live logs + state over SSE, with replay of everything already emitted. */
  useEffect(() => {
    setLogs([]);
    const source = new EventSource(`/api/deployments/${id}/events`);

    source.addEventListener('log', (event) => {
      const line = JSON.parse((event as MessageEvent).data) as LogLine;
      setLogs((current) =>
        current.some((l) => l.seq === line.seq) ? current : [...current, line]
      );
    });

    source.addEventListener('state', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        state: Deployment['state'];
        deployment?: Deployment;
      };
      if (payload.deployment) setDeployment(payload.deployment);
      else
        setDeployment((current) =>
          current ? { ...current, state: payload.state } : current
        );
    });

    source.addEventListener('done', () => {
      source.close();
      api
        .deployment(id)
        .then(({ deployment: d }) => setDeployment(d))
        .catch(() => {});
    });

    source.onerror = () => source.close();
    return () => source.close();
  }, [id]);

  useEffect(() => {
    if (follow && logBox.current) {
      logBox.current.scrollTop = logBox.current.scrollHeight;
    }
  }, [logs, follow]);

  async function act(
    label: string,
    fn: () => Promise<unknown>,
    after?: () => void
  ) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
      after?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy('');
    }
  }

  if (!deployment) {
    return (
      <div className="container">
        <Alert kind="error">{error}</Alert>
        {!error ? <Spinner label="Loading deployment…" /> : null}
      </div>
    );
  }

  const active = ACTIVE_STATES.includes(deployment.state);

  return (
    <div className="container wide">
      <div className="page-head">
        <div className="stack">
          <div className="row">
            <Link className="small muted" to={`/projects/${slug}`}>
              ← {deployment.projectName}
            </Link>
          </div>
          <h1 className="mono" style={{ fontSize: 18 }}>
            {deployment.id}
          </h1>
        </div>
        <div className="spacer" />
        <StatusBadge state={deployment.state} />
        <TargetBadge deployment={deployment} />
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <div className="card">
        <div className="card-body">
          <dl className="kv">
            <dt>URL</dt>
            <dd>
              <a href={deployment.url} target="_blank" rel="noreferrer">
                {deployment.host}
              </a>
            </dd>
            <dt>Aliases</dt>
            <dd>
              {deployment.aliases.length
                ? deployment.aliases.map((alias) => (
                    <div key={alias.domain}>
                      <a href={alias.url} target="_blank" rel="noreferrer">
                        {alias.domain}
                      </a>{' '}
                      <span className="faint small">({alias.type})</span>
                    </div>
                  ))
                : '—'}
            </dd>
            <dt>Source</dt>
            <dd>
              {deployment.branch ?? '—'}
              {deployment.commit ? (
                <>
                  {' · '}
                  <span className="mono">{deployment.commit.shortSha}</span>
                  {' · '}
                  {deployment.commit.message}
                </>
              ) : null}
              {deployment.prNumber ? ` · PR #${deployment.prNumber}` : ''}
            </dd>
            <dt>Created</dt>
            <dd>
              <TimeAgo value={deployment.createdAt} /> via {deployment.source}
            </dd>
            <dt>Build time</dt>
            <dd>
              <Duration ms={deployment.buildDurationMs} />
            </dd>
            <dt>Framework</dt>
            <dd>
              {deployment.framework ?? 'static'}
              {deployment.serveMode ? ` · ${deployment.serveMode} runtime` : ''}
            </dd>
          </dl>

          {deployment.error ? (
            <div style={{ marginTop: 16 }}>
              <Alert kind="error">{deployment.error}</Alert>
            </div>
          ) : null}
        </div>
        <div className="card-foot">
          <a
            className="btn"
            href={deployment.url}
            target="_blank"
            rel="noreferrer"
          >
            Visit
          </a>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() =>
              act('redeploy', async () => {
                const { deployment: created } = await api.redeploy(deployment.id);
                navigate(`/projects/${slug}/deployments/${created.id}`);
              })
            }
          >
            {busy === 'redeploy' ? 'Queuing…' : 'Redeploy'}
          </button>
          {deployment.state === 'READY' && !deployment.isCurrentProduction ? (
            <button
              className="btn accent"
              disabled={Boolean(busy)}
              onClick={() =>
                act(
                  'promote',
                  async () => {
                    const result = await api.promote(deployment.id);
                    setNotice(
                      `Production now serves this deployment: ${result.domains.join(', ')}`
                    );
                    const { deployment: fresh } = await api.deployment(
                      deployment.id
                    );
                    setDeployment(fresh);
                  }
                )
              }
            >
              {busy === 'promote' ? 'Promoting…' : 'Promote to Production'}
            </button>
          ) : null}
          {active ? (
            <button
              className="btn danger"
              disabled={Boolean(busy)}
              onClick={() => act('cancel', () => api.cancel(deployment.id))}
            >
              Cancel build
            </button>
          ) : null}
          <div className="spacer" />
          {!deployment.isCurrentProduction ? (
            <button
              className="btn danger sm"
              disabled={Boolean(busy)}
              onClick={() =>
                act('delete', () => api.deleteDeployment(deployment.id), () =>
                  navigate(`/projects/${slug}`)
                )
              }
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Build logs</h2>
          {active ? <Spinner /> : null}
          <div className="spacer" />
          <label className="switch small">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            Follow output
          </label>
          <span className="small faint">{logs.length} lines</span>
        </div>
        <div className="card-body" style={{ padding: 12 }}>
          <div
            className="logs"
            ref={logBox}
            onScroll={(event) => {
              const el = event.currentTarget;
              const atBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              if (!atBottom && follow) setFollow(false);
            }}
          >
            {logs.length === 0 ? (
              <div className="log-line faint">
                <span>Waiting for build output…</span>
              </div>
            ) : (
              logs.map((line) => (
                <div key={line.seq} className={`log-line ${line.level}`}>
                  <span className="ts">
                    {new Date(line.ts).toISOString().slice(11, 19)}
                  </span>
                  <span>{line.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
