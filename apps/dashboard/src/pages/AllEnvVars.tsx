import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type EnvVarRow } from '../api.ts';
import { Alert, EmptyState, Spinner, TimeAgo } from '../components/ui.tsx';
import { useProjects } from '../projects.ts';

interface Row extends EnvVarRow {
  projectSlug: string;
  projectName: string;
}

/**
 * The `/env` tab of the home shell: every environment variable across every
 * project. Adding one still happens from a project's own Settings tab — a
 * variable belongs to exactly one project, so there is nothing sensible for
 * an "add" form to attach to up here.
 */
export function AllEnvVars() {
  const { projects, loaded } = useProjects();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!loaded) return;
    setError('');
    try {
      const lists = await Promise.all(
        projects.map((project) =>
          api
            .env(project.slug)
            .then(({ env }) =>
              env.map((row) => ({
                ...row,
                projectSlug: project.slug,
                projectName: project.name,
              }))
            )
        )
      );
      setRows(
        lists
          .flat()
          .sort(
            (a, b) =>
              a.projectName.localeCompare(b.projectName) ||
              a.key.localeCompare(b.key)
          )
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load environment variables'
      );
    }
  }, [projects, loaded]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-title">
        <h1>Environment Variables</h1>
        <div className="spacer" />
        <span className="small faint">
          {rows?.length ?? 0} across {projects.length} project
          {projects.length === 1 ? '' : 's'}
        </span>
      </div>

      <Alert kind="error">{error}</Alert>

      <section className="panel">
        {rows === null ? (
          <div className="panel-body">
            <Spinner label="Loading variables…" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No environment variables yet"
            description="Add one from a project's Settings → Environment Variables tab."
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Key</th>
                <th>Value</th>
                <th>Environment</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.projectSlug}:${row.id}`}>
                  <td>
                    <Link
                      className="link"
                      to={`/projects/${row.projectSlug}/settings/env`}
                    >
                      {row.projectName}
                    </Link>
                  </td>
                  <td className="mono">{row.key}</td>
                  <td className="mono faint">{revealed[row.id] ?? row.preview}</td>
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
                        const { value } = await api.revealEnv(row.projectSlug, row.id);
                        setRevealed((current) => ({ ...current, [row.id]: value }));
                      }}
                    >
                      Reveal
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        await api.deleteEnv(row.projectSlug, row.id);
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
      </section>
    </>
  );
}
