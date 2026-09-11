import React, { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api, ApiError, type Deployment, type Project } from '../api.ts';
import { Alert, Duration, StatusBadge, TimeAgo } from '../components/ui.tsx';

interface Context {
  project: Project;
  reload: () => Promise<void>;
}

/** Short author label from a `Name <email>` commit author string. */
function authorName(author: string | null): string {
  if (!author) return 'unknown';
  return author.replace(/\s*<[^>]*>\s*$/, '').trim() || author;
}

function initials(value: string): string {
  return value
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function ProjectOverview() {
  const { project, reload } = useOutletContext<Context>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null);

  const production = project.productionDeployment;

  /** The newest READY deployment that is not the one already live. */
  const findRollbackTarget = useCallback(async () => {
    try {
      const { deployments } = await api.projectDeployments(project.slug, 25);
      setRollbackTarget(
        deployments.find(
          (d) => d.state === 'READY' && d.id !== production?.id
        ) ?? null
      );
    } catch {
      setRollbackTarget(null);
    }
  }, [project.slug, production?.id]);

  useEffect(() => {
    void findRollbackTarget();
  }, [findRollbackTarget]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
      await reload();
      await findRollbackTarget();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      <section className="panel">
        <header className="panel-head">
          <h2>Production Deployment</h2>
          <div className="spacer" />
          {project.repo?.provider === 'github' ? (
            <a
              className="icon-btn"
              href={project.repo.url}
              target="_blank"
              rel="noreferrer"
              title="View repository"
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
              </svg>
            </a>
          ) : null}

          <button
            className="btn sm"
            disabled={Boolean(busy) || !rollbackTarget}
            title={
              rollbackTarget
                ? `Roll back to ${rollbackTarget.id}`
                : 'No earlier ready deployment to roll back to'
            }
            onClick={() =>
              act('rollback', async () => {
                const result = await api.promote(rollbackTarget!.id);
                setNotice(
                  `Production now serves ${rollbackTarget!.commit?.shortSha ?? rollbackTarget!.id} — ${result.domains.join(', ')}`
                );
              })
            }
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M2.5 8a5.5 5.5 0 1 0 1.7-3.97M2.5 2.5V6H6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {busy === 'rollback' ? 'Rolling back…' : 'Instant Rollback'}
          </button>

          <a
            className="btn sm primary"
            href={project.productionUrl}
            target="_blank"
            rel="noreferrer"
          >
            Visit
          </a>
        </header>

        {production ? (
          <div className="panel-body deployment-hero">
            <div className="hero-preview">
              {/* A live screenshot would need a headless browser; the deployed
                  page itself is one click away instead. */}
              <a href={project.productionUrl} target="_blank" rel="noreferrer">
                <div className="hero-preview-inner">
                  <span className="hero-preview-domain">
                    {project.productionUrl.replace(/^https?:\/\//, '')}
                  </span>
                  <span className="hero-preview-hint">Open deployment ↗</span>
                </div>
              </a>
            </div>

            <dl className="hero-facts">
              <dt>Deployment</dt>
              <dd>
                <Link
                  className="mono link"
                  to={`/projects/${project.slug}/deployments/${production.id}`}
                >
                  {production.host}
                </Link>
              </dd>

              <dt>Domains</dt>
              <dd>
                {production.aliases.length ? (
                  production.aliases
                    .filter((a) => a.type !== 'deployment')
                    .map((alias) => (
                      <div key={alias.domain}>
                        <a href={alias.url} target="_blank" rel="noreferrer" className="link">
                          {alias.domain} ↗
                        </a>
                      </div>
                    ))
                ) : (
                  <span className="faint">—</span>
                )}
              </dd>

              <dt>Status</dt>
              <dd className="hero-status">
                <StatusBadge state={production.state} />
                <span className="faint small">
                  built in <Duration ms={production.buildDurationMs} />
                </span>
              </dd>

              <dt>Created</dt>
              <dd>
                <TimeAgo value={production.createdAt} /> by{' '}
                {authorName(production.commit?.author ?? null)}
                <span className="avatar tiny" aria-hidden>
                  {initials(authorName(production.commit?.author ?? 'a'))}
                </span>
              </dd>

              <dt>Source</dt>
              <dd className="hero-source">
                <div>
                  <span className="glyph">⎇</span> {production.branch}
                </div>
                {production.commit ? (
                  <div>
                    <span className="glyph">◦</span>{' '}
                    <span className="mono">{production.commit.shortSha}</span>{' '}
                    {production.commit.message}
                  </div>
                ) : null}
              </dd>
            </dl>
          </div>
        ) : (
          <div className="panel-body">
            <div className="empty">
              <h2>No production deployment yet</h2>
              <p className="small">
                Deploy the <code>{project.productionBranch}</code> branch to publish
                this project.
              </p>
              <button
                className="btn primary"
                style={{ marginTop: 16 }}
                disabled={Boolean(busy)}
                onClick={() =>
                  act('deploy', async () => {
                    await api.deploy(project.slug);
                    setNotice('Deployment queued.');
                  })
                }
              >
                {busy === 'deploy' ? 'Queuing…' : `Deploy ${project.productionBranch}`}
              </button>
            </div>
          </div>
        )}

        <div className="panel-section">
          <button
            className="disclosure"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
          >
            <span className={`chevron${settingsOpen ? ' open' : ''}`}>›</span>
            Deployment Settings
            <span className="pill">
              {project.framework ?? 'auto-detect'} · {project.serveMode ?? 'static'}
            </span>
          </button>
          {settingsOpen ? (
            <dl className="kv" style={{ padding: '4px 20px 20px' }}>
              <dt>Framework</dt>
              <dd>{project.framework ?? 'auto-detected each build'}</dd>
              <dt>Build command</dt>
              <dd className="mono">{project.buildCommand ?? 'framework default'}</dd>
              <dt>Output directory</dt>
              <dd className="mono">{project.outputDirectory ?? 'auto-detected'}</dd>
              <dt>Install command</dt>
              <dd className="mono">{project.installCommand ?? 'from the lockfile'}</dd>
              <dt>Root directory</dt>
              <dd className="mono">{project.rootDirectory ?? './'}</dd>
              <dt>Node.js version</dt>
              <dd>{project.nodeVersion}</dd>
              <dt />
              <dd>
                <Link className="btn sm" to={`/projects/${project.slug}/settings`}>
                  Edit settings
                </Link>
              </dd>
            </dl>
          ) : null}
        </div>

        <footer className="panel-foot">
          <span className="small muted">
            To update your Production Deployment, push to the{' '}
            <code>{project.productionBranch}</code> branch.
          </span>
          <div className="spacer" />
          <Link className="btn sm" to={`/projects/${project.slug}/deployments`}>
            Deployments
          </Link>
        </footer>
      </section>
    </>
  );
}
