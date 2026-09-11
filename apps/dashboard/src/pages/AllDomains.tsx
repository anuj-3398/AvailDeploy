import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.ts';
import { Alert, EmptyState, Spinner } from '../components/ui.tsx';
import { useProjects } from '../projects.ts';

interface DomainRow {
  id: string;
  domain: string;
  url: string;
  type: string;
  projectSlug: string;
  projectName: string;
}

/**
 * The `/domains` tab of the home shell: every domain across every project.
 * Adding a custom domain still happens from a project's own Settings tab — a
 * domain always points at one project's production deployment.
 */
export function AllDomains() {
  const { projects, loaded } = useProjects();
  const [rows, setRows] = useState<DomainRow[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!loaded) return;
    setError('');
    try {
      const lists = await Promise.all(
        projects.map((project) =>
          api
            .domains(project.slug)
            .then(({ domains }) =>
              domains.map((row) => ({
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
              a.domain.localeCompare(b.domain)
          )
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load domains');
    }
  }, [projects, loaded]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-title">
        <h1>Domains</h1>
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
            <Spinner label="Loading domains…" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No domains yet"
            description="Add a custom domain from a project's Settings → Domains tab."
          />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Domain</th>
                <th>Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.projectSlug}:${row.id}`}>
                  <td>
                    <Link
                      className="link"
                      to={`/projects/${row.projectSlug}/settings/domains`}
                    >
                      {row.projectName}
                    </Link>
                  </td>
                  <td>
                    <a href={row.url} target="_blank" rel="noreferrer">
                      {row.domain}
                    </a>
                  </td>
                  <td className="faint">{row.type}</td>
                  <td style={{ textAlign: 'right' }}>
                    {row.type === 'custom' ? (
                      <Link
                        className="btn sm ghost"
                        to={`/projects/${row.projectSlug}/settings/domains`}
                      >
                        Manage
                      </Link>
                    ) : null}
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
