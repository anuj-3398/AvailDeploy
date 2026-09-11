import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Integration } from '../api.ts';
import { Alert, Spinner, TimeAgo } from '../components/ui.tsx';

export function GitSettings() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{
    githubOAuth: boolean;
    webhookUrl: string;
    buildExecutor: string;
    deploymentDomain: string;
  } | null>(null);
  const [status, setStatus] = useState<any>(null);

  const load = useCallback(async () => {
    const [list, systemInfo] = await Promise.all([
      api.integrations().catch(() => ({ integrations: [] })),
      api.systemInfo().catch(() => null),
    ]);
    setIntegrations(list.integrations);
    setInfo(systemInfo as any);
    api.systemStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    if (new URLSearchParams(window.location.search).get('connected')) {
      setNotice('GitHub account connected.');
    }
  }, [load]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const { integration } = await api.connectToken(token.trim());
      setToken('');
      setNotice(`Connected as ${integration.login}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="stack">
          <h1>Git Integration</h1>
          <span className="sub">
            Connect GitHub so the platform can list repositories, clone private
            code, register webhooks and report build status back to commits.
          </span>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <div className="card">
        <div className="card-head">
          <h2>Connected accounts</h2>
        </div>
        {integrations === null ? (
          <div className="card-body">
            <Spinner label="Loading…" />
          </div>
        ) : integrations.length === 0 ? (
          <div className="card-body muted small">
            No GitHub account is connected yet.
          </div>
        ) : (
          <div className="list">
            {integrations.map((integration) => (
              <div key={integration.id} className="list-item">
                {integration.avatarUrl ? (
                  <img
                    src={integration.avatarUrl}
                    alt=""
                    width={28}
                    height={28}
                    style={{ borderRadius: '50%' }}
                  />
                ) : null}
                <div className="stack" style={{ flex: 1 }}>
                  <strong>{integration.login}</strong>
                  <span className="small faint">
                    {integration.kind === 'oauth'
                      ? 'OAuth app'
                      : 'Personal access token'}{' '}
                    · added <TimeAgo value={integration.createdAt} />
                  </span>
                </div>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    await api.disconnect(integration.id);
                    await load();
                  }}
                >
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}
        {info?.githubOAuth ? (
          <div className="card-foot">
            <a className="btn accent" href="/api/auth/github/start?intent=connect">
              Connect with GitHub OAuth
            </a>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Personal access token</h2>
        </div>
        <form onSubmit={connect}>
          <div className="card-body">
            <p className="muted small">
              Create a token with the <code>repo</code> and{' '}
              <code>admin:repo_hook</code> scopes at{' '}
              <a
                href="https://github.com/settings/tokens/new"
                target="_blank"
                rel="noreferrer"
              >
                github.com/settings/tokens
              </a>
              . Tokens are encrypted at rest with AES-256-GCM.
            </p>
            <div className="field">
              <input
                className="input mono"
                type="password"
                placeholder="ghp_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
          </div>
          <div className="card-foot">
            <button className="btn primary" disabled={busy || !token.trim()}>
              {busy ? 'Verifying…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Platform</h2>
          <div className="spacer" />
          <button
            className="btn sm"
            onClick={async () => {
              try {
                const result = await api.poll();
                setNotice(
                  `Checked ${result.checked} repositories, queued ${result.triggered} deployment(s).`
                );
              } catch (err) {
                setError(err instanceof ApiError ? err.message : 'Could not poll repositories');
              }
            }}
          >
            Check repositories now
          </button>
        </div>
        <div className="card-body">
          <dl className="kv">
            <dt>Webhook endpoint</dt>
            <dd className="mono">{info?.webhookUrl ?? '—'}</dd>
            <dt>Deployment domain</dt>
            <dd className="mono">*.{info?.deploymentDomain ?? '—'}</dd>
            <dt>Build executor</dt>
            <dd>
              {info?.buildExecutor ?? '—'}
              {status?.executor && status.executor.ok !== null
                ? ` · ${status.executor.ok ? 'ok' : 'unavailable'} (${status.executor.detail?.split('\n')[0]})`
                : ''}
            </dd>
            <dt>Build queue</dt>
            <dd>
              {status?.queue
                ? `${status.queue.running} running, ${status.queue.pending} pending (concurrency ${status.queue.concurrency})`
                : '—'}
            </dd>
            <dt>Repository polling</dt>
            <dd>
              {status?.poller
                ? status.poller.enabled
                  ? `every ${Math.round(status.poller.intervalMs / 1000)}s`
                  : 'disabled'
                : '—'}
            </dd>
          </dl>
        </div>
      </div>
    </>
  );
}
