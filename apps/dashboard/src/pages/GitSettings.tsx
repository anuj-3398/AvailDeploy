import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Integration, type Member } from '../api.ts';
import { Alert, PasswordField, Spinner, TimeAgo } from '../components/ui.tsx';

function initials(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function GitSettings() {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
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
  const [showTokenForm, setShowTokenForm] = useState(false);

  const load = useCallback(async () => {
    const [list, systemInfo] = await Promise.all([
      api.integrations().catch(() => ({ integrations: [] })),
      api.systemInfo().catch(() => null),
    ]);
    setIntegrations(list.integrations);
    setInfo(systemInfo as any);
    api.systemStatus().then(setStatus).catch(() => {});
    api.members().then((r) => setMembers(r.members)).catch(() => {});
  }, []);

  useEffect(() => {
    void load();
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected')) {
      setNotice('GitHub account connected.');
    }
    const oauthError = params.get('error');
    if (oauthError) {
      setError(oauthError);
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

      {info?.githubOAuth && !showTokenForm ? (
        <div className="card">
          <div className="card-body" style={{ padding: 12 }}>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => setShowTokenForm(true)}
            >
              Use a personal access token instead
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head">
            <h2>Personal access token</h2>
            {info?.githubOAuth ? (
              <>
                <div className="spacer" />
                <span className="small faint">
                  Most people want{' '}
                  <strong>Connect with GitHub OAuth</strong> above instead
                </span>
              </>
            ) : null}
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
                <PasswordField
                  className="mono"
                  placeholder="ghp_…"
                  value={token}
                  onChange={setToken}
                />
              </div>
            </div>
            <div className="card-foot">
              <button className="btn primary" disabled={busy || !token.trim()}>
                {busy ? 'Verifying…' : 'Connect'}
              </button>
              {info?.githubOAuth ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => setShowTokenForm(false)}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Team</h2>
        </div>
        <div className="card-body muted small">
          Role is workspace-wide — the same for every project, not set per
          project. The first person to ever sign in is the <strong>admin</strong>;
          everyone else who signs in is a <strong>member</strong>. Deleting a
          project or removing one of its custom domains needs either the
          admin, or whoever originally created that specific project — a
          member can't touch a project someone else on the workspace
          created. Everything else — deploying, editing env vars,
          connecting Git, commenting — is the same for both.
        </div>
        {members.length > 0 ? (
          <div className="list">
            {members.map((member) => (
              <div key={member.id} className="list-item">
                <span className="avatar tiny" aria-hidden>
                  {initials(member.name ?? member.email)}
                </span>
                <div className="stack" style={{ flex: 1 }}>
                  <strong>{member.name ?? member.email}</strong>
                  <span className="small faint">{member.email}</span>
                </div>
                <span className={`btn sm ${member.role === 'admin' ? '' : 'ghost'}`}>
                  {member.role === 'admin' ? '★ Admin' : 'Member'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
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
