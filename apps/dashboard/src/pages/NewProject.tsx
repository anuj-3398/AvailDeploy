import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, type Repo } from '../api.ts';
import { Alert, EmptyState, Spinner, TimeAgo } from '../components/ui.tsx';

type Mode = 'github' | 'url';

export function NewProject() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('github');
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [reposError, setReposError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Repo | null>(null);
  const [repoUrl, setRepoUrl] = useState('');

  const [name, setName] = useState('');
  const [productionBranch, setProductionBranch] = useState('main');
  const [rootDirectory, setRootDirectory] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [outputDirectory, setOutputDirectory] = useState('');
  const [installCommand, setInstallCommand] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .repos()
      .then((r) => setRepos(r.repos))
      .catch((err: ApiError) => {
        setReposError(err.message);
        setRepos([]);
        if (err.code === 'no_integration') setMode('url');
      });
  }, []);

  function choose(repo: Repo) {
    setSelected(repo);
    setName(repo.name);
    setProductionBranch(repo.defaultBranch);
  }

  function parseEnv() {
    return envText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=');
        if (eq === -1) return null;
        return {
          key: line.slice(0, eq).trim(),
          value: line.slice(eq + 1).trim().replace(/^["']|["']$/g, ''),
          target: 'production',
        };
      })
      .filter(Boolean) as { key: string; value: string; target: string }[];
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { project } = await api.createProject({
        name: name.trim() || undefined,
        repoFullName: mode === 'github' ? selected?.fullName : undefined,
        repoUrl: mode === 'url' ? repoUrl.trim() : undefined,
        integrationId: mode === 'github' ? selected?.integrationId : undefined,
        productionBranch: productionBranch.trim() || 'main',
        rootDirectory: rootDirectory.trim() || null,
        buildCommand: buildCommand.trim() || null,
        outputDirectory: outputDirectory.trim() || null,
        installCommand: installCommand.trim() || null,
        env: parseEnv(),
        deploy: true,
      });
      navigate(`/projects/${project.slug}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create project');
    } finally {
      setBusy(false);
    }
  }

  const readyToSubmit =
    mode === 'github' ? Boolean(selected) : repoUrl.trim().length > 3;

  const filtered = (repos ?? []).filter((repo) =>
    query ? repo.fullName.toLowerCase().includes(query.toLowerCase()) : true
  );

  return (
    <div className="container">
      <div className="page-head">
        <div className="stack">
          <h1>Import a Git Repository</h1>
          <span className="sub">
            Every push builds a deployment. Pushes to the production branch go
            live; every other branch gets a preview URL.
          </span>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      <div className="tabs">
        <a
          className={mode === 'github' ? 'active' : ''}
          onClick={() => setMode('github')}
          href="#github"
        >
          GitHub repository
        </a>
        <a
          className={mode === 'url' ? 'active' : ''}
          onClick={() => setMode('url')}
          href="#url"
        >
          Git URL or local path
        </a>
      </div>

      <form onSubmit={submit}>
        {mode === 'github' ? (
          <div className="card">
            <div className="card-head">
              <h2>Choose a repository</h2>
              <div className="spacer" />
              <input
                className="input"
                style={{ maxWidth: 220 }}
                placeholder="Search…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {repos === null ? (
              <div className="card-body">
                <Spinner label="Loading repositories…" />
              </div>
            ) : repos.length === 0 ? (
              <EmptyState
                title="No repositories available"
                description={
                  reposError || 'Connect a GitHub account to import a repository.'
                }
                action={
                  <Link className="btn primary" to="/settings/git">
                    Connect GitHub
                  </Link>
                }
              />
            ) : (
              <div className="list" style={{ maxHeight: 380, overflow: 'auto' }}>
                {filtered.map((repo) => (
                  <div
                    key={repo.fullName}
                    className="list-item"
                    style={{
                      cursor: 'pointer',
                      background:
                        selected?.fullName === repo.fullName
                          ? 'var(--bg-hover)'
                          : undefined,
                    }}
                    onClick={() => choose(repo)}
                  >
                    <img
                      src={repo.ownerAvatar}
                      alt=""
                      width={24}
                      height={24}
                      style={{ borderRadius: 6 }}
                    />
                    <div className="stack" style={{ flex: 1 }}>
                      <span className="ellipsis">{repo.fullName}</span>
                      <span className="small faint ellipsis">
                        {repo.private ? 'Private · ' : 'Public · '}
                        pushed <TimeAgo value={Date.parse(repo.pushedAt)} />
                      </span>
                    </div>
                    <button
                      type="button"
                      className={
                        selected?.fullName === repo.fullName
                          ? 'btn sm primary'
                          : 'btn sm'
                      }
                    >
                      {selected?.fullName === repo.fullName ? 'Selected' : 'Select'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="card">
            <div className="card-body">
              <div className="field">
                <label htmlFor="repoUrl">Repository URL or local path</label>
                <input
                  id="repoUrl"
                  className="input"
                  placeholder="https://github.com/availproject/my-app  or  D:/work/my-app"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                />
                <span className="hint">
                  A local path is cloned directly — useful for testing the
                  platform without a remote.
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <div className="card-head">
            <h2>Project settings</h2>
          </div>
          <div className="card-body">
            <div className="field-row">
              <div className="field">
                <label htmlFor="name">Project name</label>
                <input
                  id="name"
                  className="input"
                  placeholder="my-app"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="branch">Production branch</label>
                <input
                  id="branch"
                  className="input"
                  value={productionBranch}
                  onChange={(e) => setProductionBranch(e.target.value)}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="root">Root directory</label>
                <input
                  id="root"
                  className="input"
                  placeholder="./"
                  value={rootDirectory}
                  onChange={(e) => setRootDirectory(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="install">Install command</label>
                <input
                  id="install"
                  className="input"
                  placeholder="auto-detected"
                  value={installCommand}
                  onChange={(e) => setInstallCommand(e.target.value)}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="build">Build command</label>
                <input
                  id="build"
                  className="input"
                  placeholder="auto-detected"
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="output">Output directory</label>
                <input
                  id="output"
                  className="input"
                  placeholder="auto-detected"
                  value={outputDirectory}
                  onChange={(e) => setOutputDirectory(e.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="env">Environment variables</label>
              <textarea
                id="env"
                className="textarea"
                placeholder={'API_URL=https://api.example.com\nDEBUG=false'}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
              />
              <span className="hint">
                One <code>KEY=value</code> per line. Applied to the production
                environment; add preview values later in project settings.
              </span>
            </div>
          </div>
          <div className="card-foot">
            <button
              className="btn primary"
              disabled={busy || !readyToSubmit}
            >
              {busy ? 'Creating…' : 'Deploy'}
            </button>
            <Link className="btn ghost" to="/">
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </div>
  );
}
