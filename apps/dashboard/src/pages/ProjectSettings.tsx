import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type EnvVarRow, type Member, type Project } from '../api.ts';
import { Alert, CopyField, Spinner, TimeAgo } from '../components/ui.tsx';
import { useAuth } from '../auth.ts';
import { useProjects } from '../projects.ts';

type Tab = 'general' | 'build' | 'env' | 'domains' | 'git';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'build', label: 'Build & Output' },
  { id: 'env', label: 'Environment Variables' },
  { id: 'domains', label: 'Domains' },
  { id: 'git', label: 'Git' },
];

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

export function ProjectSettings() {
  const { slug = '', tab: tabParam } = useParams();
  const navigate = useNavigate();
  // The tab lives in the URL so the sidebar can deep-link into Environment
  // Variables or Domains, and so back/forward moves between them.
  const tab: Tab = TAB_IDS.has(tabParam ?? '') ? (tabParam as Tab) : 'general';
  const setTab = (next: Tab) =>
    navigate(
      `/projects/${slug}/settings${next === 'general' ? '' : `/${next}`}`
    );
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const { project: p } = await api.project(slug);
      setProject(p);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load project');
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Record<string, unknown>) {
    setError('');
    setNotice('');
    try {
      const { project: updated } = await api.updateProject(slug, patch);
      setProject(updated);
      setNotice('Saved. New settings apply to the next deployment.');
      if (updated.slug !== slug) navigate(`/projects/${updated.slug}/settings`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  }

  function onTransferred(updated: Project, message: string) {
    setError('');
    setProject(updated);
    setNotice(message);
  }

  if (!project) {
    return (
      <>
        <Alert kind="error">{error}</Alert>
        {!error ? <Spinner label="Loading…" /> : null}
      </>
    );
  }

  return (
    <>
      <div className="page-title">
        <h1>{TABS.find((t) => t.id === tab)?.label ?? 'Settings'}</h1>
      </div>

      <div className="tabs">
        {TABS.map((item) => (
          <Link
            key={item.id}
            to={`/projects/${slug}/settings${item.id === 'general' ? '' : `/${item.id}`}`}
            className={tab === item.id ? 'active' : ''}
          >
            {item.label}
          </Link>
        ))}
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="success">{notice}</Alert>

      {tab === 'general' ? (
        <GeneralTab
          project={project}
          onSave={save}
          onTransferred={onTransferred}
          slug={slug}
        />
      ) : null}
      {tab === 'build' ? <BuildTab project={project} onSave={save} /> : null}
      {tab === 'env' ? <EnvTab slug={slug} /> : null}
      {tab === 'domains' ? <DomainsTab slug={slug} /> : null}
      {tab === 'git' ? (
        <GitTab project={project} slug={slug} onSave={save} />
      ) : null}
    </>
  );
}

function GeneralTab({
  project,
  onSave,
  onTransferred,
  slug,
}: {
  project: Project;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  onTransferred: (project: Project, message: string) => void;
  slug: string;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { remove: removeProject, nextSlugAfter } = useProjects();
  const [name, setName] = useState(project.name);
  const [nodeVersion, setNodeVersion] = useState(project.nodeVersion);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Same rule the server enforces (require_admin_or_creator) — a member
  // who's neither gets the button disabled rather than an error only after
  // typing the whole confirmation out.
  const canDelete = user.role === 'admin' || project.createdBy?.id === user.id;

  return (
    <>
      <Alert kind="error">{deleteError}</Alert>

      <div className="card">
        <div className="card-head">
          <h2>Project name</h2>
        </div>
        <div className="card-body">
          <div className="field">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="hint">
              The URL slug <code>{project.slug}</code> stays the same so existing
              deployment domains keep working.
            </span>
          </div>
          <div className="field">
            <label>Node.js version</label>
            <select
              className="select"
              value={nodeVersion}
              onChange={(e) => setNodeVersion(e.target.value)}
            >
              {['24.x', '22.x', '20.x', '18.x'].map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="card-foot">
          <button
            className="btn primary"
            onClick={() => onSave({ name, nodeVersion })}
          >
            Save
          </button>
        </div>
      </div>

      <TransferOwnershipCard project={project} onTransferred={onTransferred} />

      <div className="card">
        <div className="card-head">
          <h2 style={{ color: 'var(--danger)' }}>Delete project</h2>
        </div>
        {confirming ? (
          <>
            <div className="card-body">
              <p className="muted small">
                This action is <strong>permanent and cannot be undone</strong>.
                Deleting <strong>{project.name}</strong> removes the project
                itself along with every deployment, build artifact,
                environment variable, and domain attached to it.
              </p>
              <div className="field">
                <label htmlFor="delete-confirm-name">
                  Type <code>{project.name}</code> to confirm
                </label>
                <input
                  id="delete-confirm-name"
                  className="input"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
              </div>
            </div>
            <div className="card-foot">
              <button
                className="btn danger"
                disabled={deleting || confirmText !== project.name}
                onClick={async () => {
                  setDeleting(true);
                  setDeleteError('');
                  // Work out where to go before the project disappears, then
                  // drop it from the shared list so the switcher and the `/`
                  // redirect cannot point at it any more.
                  const next = nextSlugAfter(project.id);
                  try {
                    await api.deleteProject(slug);
                  } catch (err) {
                    setDeleting(false);
                    setConfirming(false);
                    setConfirmText('');
                    setDeleteError(
                      err instanceof ApiError ? err.message : 'Could not delete this project'
                    );
                    return;
                  }
                  removeProject(project.id);
                  navigate(next ? `/projects/${next}` : '/', {
                    replace: true,
                  });
                }}
              >
                {deleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
              <button
                className="btn ghost"
                disabled={deleting}
                onClick={() => {
                  setConfirming(false);
                  setConfirmText('');
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="card-body">
              <p className="muted small">
                Removes the project, its deployments and all build artifacts.
                This cannot be undone.
                {!canDelete ? (
                  <>
                    {' '}
                    Only the workspace admin or this project's owner can do
                    that.
                  </>
                ) : null}
              </p>
            </div>
            <div className="card-foot">
              <button
                className="btn danger"
                disabled={!canDelete}
                title={canDelete ? undefined : "Only the workspace admin or this project's owner can delete it"}
                onClick={() => setConfirming(true)}
              >
                Delete project
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function TransferOwnershipCard({
  project,
  onTransferred,
}: {
  project: Project;
  onTransferred: (project: Project, message: string) => void;
}) {
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .members()
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  }, []);

  // Same gate as the server's own require_creator on the transfer/cancel
  // endpoints — deliberately creator-only, no admin override (unlike
  // deleting the project). Hiding it from everyone else isn't just tidier:
  // it stops the admin from ever landing on a project they don't own and
  // finding a live Cancel button for a transfer that isn't theirs to touch.
  const canManage = project.createdBy?.id === user.id;
  if (!canManage) return null;

  const pending = project.pendingTransfer;
  const candidates = (members ?? []).filter((m) => m.id !== project.createdBy?.id);
  const target = candidates.find((m) => m.id === targetId);

  async function requestTransfer() {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      const { project: updated } = await api.transferProject(project.slug, target.id);
      onTransferred(updated, `Transfer requested — waiting on ${target.name ?? target.email} to accept.`);
      setTargetId('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request this transfer');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      const { project: updated } = await api.cancelTransfer(project.slug);
      onTransferred(updated, 'Transfer canceled.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel this transfer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Transfer ownership</h2>
      </div>
      <div className="card-body">
        <Alert kind="error">{error}</Alert>
        {pending ? (
          <p className="muted small">
            Waiting on <strong>{pending.toUser?.name ?? pending.toUser?.email ?? 'them'}</strong> to
            accept. They'll see a notification with Accept/Decline — nothing
            changes until they respond, and you can pull the request back
            any time before then.
          </p>
        ) : (
          <p className="muted small">
            Offers this project to another member of the workspace — once
            they accept, they become who it's created by, able to delete it
            or remove its domains without needing the admin. This doesn't
            change who can deploy or edit it; that's already open to
            everyone in the workspace.
          </p>
        )}
        {!pending && members === null ? (
          <Spinner label="Loading team…" />
        ) : !pending && candidates.length === 0 ? (
          <p className="small faint">No other workspace members to transfer to yet.</p>
        ) : !pending ? (
          <div className="field">
            <label htmlFor="transfer-target">New owner</label>
            <select
              id="transfer-target"
              className="select"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">Choose a member…</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name ? `${m.name} (${m.email})` : m.email}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="card-foot">
        {pending ? (
          <>
            <button className="btn" disabled>
              Transfer in progress
            </button>
            <button className="btn ghost" disabled={busy} onClick={cancel}>
              {busy ? 'Canceling…' : 'Cancel'}
            </button>
          </>
        ) : candidates.length > 0 ? (
          <button className="btn" disabled={busy || !targetId} onClick={requestTransfer}>
            {busy ? 'Requesting…' : 'Transfer ownership'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BuildTab({
  project,
  onSave,
}: {
  project: Project;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    framework: project.framework ?? '',
    rootDirectory: project.rootDirectory ?? '',
    installCommand: project.installCommand ?? '',
    buildCommand: project.buildCommand ?? '',
    outputDirectory: project.outputDirectory ?? '',
    serveMode: project.serveMode ?? '',
  });
  const [frameworks, setFrameworks] = useState<
    { slug: string; name: string }[]
  >([]);

  useEffect(() => {
    api
      .frameworks()
      .then((r) => setFrameworks(r.frameworks))
      .catch(() => {});
  }, []);

  const set = (key: keyof typeof form) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => setForm((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="card">
      <div className="card-head">
        <h2>Build & Output Settings</h2>
      </div>
      <div className="card-body">
        <div className="field">
          <label>Framework preset</label>
          <select
            className="select"
            value={form.framework}
            onChange={set('framework')}
          >
            <option value="">Auto-detect</option>
            {frameworks.map((framework) => (
              <option key={framework.slug} value={framework.slug}>
                {framework.name}
              </option>
            ))}
          </select>
          <span className="hint">
            Detection runs on every build using the same rules as Vercel's
            framework presets.
          </span>
        </div>

        <div className="field-row">
          <div className="field">
            <label>Root directory</label>
            <input
              className="input"
              placeholder="./"
              value={form.rootDirectory}
              onChange={set('rootDirectory')}
            />
          </div>
          <div className="field">
            <label>Serve mode</label>
            <select
              className="select"
              value={form.serveMode}
              onChange={set('serveMode')}
            >
              <option value="">Auto (static, or server for SSR)</option>
              <option value="static">Static files</option>
              <option value="server">Long-lived server process</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Install command</label>
          <input
            className="input"
            placeholder="auto-detected from the lockfile"
            value={form.installCommand}
            onChange={set('installCommand')}
          />
        </div>
        <div className="field">
          <label>Build command</label>
          <input
            className="input"
            placeholder="npm run build, or the framework default"
            value={form.buildCommand}
            onChange={set('buildCommand')}
          />
        </div>
        <div className="field">
          <label>Output directory</label>
          <input
            className="input"
            placeholder="dist / build / out"
            value={form.outputDirectory}
            onChange={set('outputDirectory')}
          />
        </div>
      </div>
      <div className="card-foot">
        <button className="btn primary" onClick={() => onSave(form)}>
          Save
        </button>
      </div>
    </div>
  );
}

function EnvTab({ slug }: { slug: string }) {
  const [rows, setRows] = useState<EnvVarRow[]>([]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [target, setTarget] = useState('production');
  const [branch, setBranch] = useState('');
  const [bulk, setBulk] = useState('');
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { env } = await api.env(slug);
    setRows(env);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api.setEnv(slug, {
        key: key.trim(),
        value,
        target,
        gitBranch: branch.trim() || undefined,
      });
      setKey('');
      setValue('');
      setBranch('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save variable');
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Add variable</h2>
        </div>
        <form onSubmit={add}>
          <div className="card-body">
            <Alert kind="error">{error}</Alert>
            <div className="field-row">
              <div className="field">
                <label>Key</label>
                <input
                  className="input"
                  placeholder="API_URL"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label>Value</label>
                <input
                  className="input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label>Environment</label>
                <select
                  className="select"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="production">Production</option>
                  <option value="preview">Preview</option>
                  <option value="development">Development</option>
                </select>
              </div>
              <div className="field">
                <label>Git branch (optional)</label>
                <input
                  className="input"
                  placeholder="only this branch"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="card-foot">
            <button className="btn primary" disabled={!key.trim()}>
              Add
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Variables</h2>
          <div className="spacer" />
          <span className="small faint">{rows.length} total</span>
        </div>
        {rows.length === 0 ? (
          <div className="card-body muted small">No variables yet.</div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Environment</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.key}</td>
                  <td className="mono faint">
                    {revealed[row.id] ?? row.preview}
                  </td>
                  <td>
                    {row.target}
                    {row.gitBranch ? ` · ${row.gitBranch}` : ''}
                  </td>
                  <td className="small faint">
                    <TimeAgo value={row.updatedAt} />
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        const { value: secret } = await api.revealEnv(
                          slug,
                          row.id
                        );
                        setRevealed((current) => ({
                          ...current,
                          [row.id]: secret,
                        }));
                      }}
                    >
                      Reveal
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        await api.deleteEnv(slug, row.id);
                        await load();
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Import from .env</h2>
        </div>
        <div className="card-body">
          <textarea
            className="textarea"
            placeholder={'KEY=value\nANOTHER=value'}
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
          />
        </div>
        <div className="card-foot">
          <button
            className="btn"
            disabled={!bulk.trim()}
            onClick={async () => {
              await api.importEnv(slug, bulk, target);
              setBulk('');
              await load();
            }}
          >
            Import into {target}
          </button>
        </div>
      </div>
    </>
  );
}

function DomainsTab({ slug }: { slug: string }) {
  const [domains, setDomains] = useState<
    { id: string; domain: string; url: string; type: string }[]
  >([]);
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { domains: list } = await api.domains(slug);
    setDomains(list);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Domains</h2>
      </div>
      <div className="card-body">
        <Alert kind="error">{error}</Alert>
        <table className="data">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {domains.map((row) => (
              <tr key={row.id}>
                <td>
                  <a href={row.url} target="_blank" rel="noreferrer">
                    {row.domain}
                  </a>
                </td>
                <td className="faint">{row.type}</td>
                <td style={{ textAlign: 'right' }}>
                  {row.type === 'custom' ? (
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        setError('');
                        try {
                          await api.removeDomain(slug, row.domain);
                          await load();
                        } catch (err) {
                          setError(
                            err instanceof ApiError ? err.message : 'Could not remove this domain'
                          );
                        }
                      }}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="field" style={{ marginTop: 20 }}>
          <label>Add a domain</label>
          <div className="row">
            <input
              className="input"
              placeholder="app.internal.availproject.org"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <button
              className="btn"
              onClick={async () => {
                setError('');
                try {
                  await api.addDomain(slug, domain.trim());
                  setDomain('');
                  await load();
                } catch (err) {
                  setError(
                    err instanceof ApiError ? err.message : 'Could not add domain'
                  );
                }
              }}
            >
              Add
            </button>
          </div>
          <span className="hint">
            Point the domain at the proxy host; it is matched on the Host header
            and always serves the current production deployment.
          </span>
        </div>
      </div>
    </div>
  );
}

function GitTab({
  project,
  slug,
  onSave,
}: {
  project: Project;
  slug: string;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [webhook, setWebhook] = useState<{
    url: string;
    secret: string;
  } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .webhookInfo(slug)
      .then(setWebhook)
      .catch(() => setWebhook(null));
  }, [slug]);

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Git integration</h2>
        </div>
        <div className="card-body">
          <dl className="kv">
            <dt>Repository</dt>
            <dd>{project.repo?.fullName ?? 'none'}</dd>
            <dt>Provider</dt>
            <dd>{project.repo?.provider ?? '—'}</dd>
            <dt>Production branch</dt>
            <dd>{project.productionBranch}</dd>
          </dl>

          <div style={{ marginTop: 20 }} className="stack">
            <label className="switch">
              <input
                type="checkbox"
                checked={project.autoDeploy}
                onChange={(e) => onSave({ autoDeploy: e.target.checked })}
              />
              Deploy automatically on push
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={project.previewDeploys}
                onChange={(e) => onSave({ previewDeploys: e.target.checked })}
              />
              Build preview deployments for other branches and pull requests
            </label>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Webhook</h2>
        </div>
        <div className="card-body">
          <Alert kind="error">{error}</Alert>
          <Alert kind="success">{message}</Alert>
          <p className="muted small">
            Add this webhook to the repository to deploy the moment a commit
            lands. Without it the platform polls the repository instead.
          </p>
          {webhook ? (
            <>
              <div className="field">
                <label>Payload URL</label>
                <CopyField value={webhook.url} />
              </div>
              <div className="field">
                <label>Secret</label>
                <CopyField value={webhook.secret} />
              </div>
            </>
          ) : null}
        </div>
        {project.repo?.provider === 'github' ? (
          <div className="card-foot">
            <button
              className="btn"
              onClick={async () => {
                setError('');
                setMessage('');
                try {
                  const result = await api.registerWebhook(slug);
                  setMessage(`Webhook created on GitHub (id ${result.hookId}).`);
                } catch (err) {
                  setError(
                    err instanceof ApiError
                      ? err.message
                      : 'Could not create webhook'
                  );
                }
              }}
            >
              Create webhook on GitHub
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
