import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useParams } from 'react-router-dom';
import { api, ApiError, type Project } from '../api.ts';
import { Alert, Spinner } from '../components/ui.tsx';

/** Icons are inline so the shell makes no third-party requests. */
const icon = {
  overview: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z',
  deployments: 'M8 1.8 14 5v6l-6 3.2L2 11V5z',
  logs: 'M3 3.5h10M3 8h10M3 12.5h6',
  env: 'M4.5 5.5 2 8l2.5 2.5M11.5 5.5 14 8l-2.5 2.5M9.5 3.5l-3 9',
  domains: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8Zm0 0c1.8 1.6 2.7 3.7 2.7 6.2S9.8 12.6 8 14.2m0-12.4C6.2 3.4 5.3 5.5 5.3 8s.9 4.6 2.7 6.2M2.2 6.4h11.6M2.2 9.6h11.6',
  settings:
    'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.4-2a5.4 5.4 0 0 0-.1-.9l1.3-1-1.3-2.2-1.5.5a5.3 5.3 0 0 0-1.5-.9L10 1.8H7.4L7.1 3.4c-.5.2-1 .5-1.5.9l-1.5-.5-1.3 2.2 1.3 1a5.4 5.4 0 0 0 0 1.8l-1.3 1 1.3 2.2 1.5-.5c.5.4 1 .7 1.5.9l.3 1.6H10l.3-1.6c.5-.2 1-.5 1.5-.9l1.5.5 1.3-2.2-1.3-1c0-.3.1-.6.1-.9Z',
};

function NavIcon({ path }: { path: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const NAV = [
  { to: '', label: 'Overview', path: icon.overview, end: true },
  { to: 'deployments', label: 'Deployments', path: icon.deployments },
  { to: 'logs', label: 'Logs', path: icon.logs },
  { to: 'settings/env', label: 'Environment Variables', path: icon.env },
  { to: 'settings/domains', label: 'Domains', path: icon.domains },
  // `end` so Settings is not also highlighted while a sub-tab is open.
  { to: 'settings', label: 'Settings', path: icon.settings, end: true },
];

/**
 * Everything under /projects/:slug shares this shell: a left nav scoped to the
 * project, with the project itself loaded once and handed to each tab.
 */
export function ProjectLayout({
  onProjectLoaded,
}: {
  onProjectLoaded: (project: Project | null) => void;
}) {
  const { slug = '' } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const { project: loaded } = await api.project(slug);
      setProject(loaded);
      onProjectLoaded(loaded);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load project');
      setProject(null);
      onProjectLoaded(null);
    }
  }, [slug, onProjectLoaded]);

  useEffect(() => {
    setProject(null);
    void reload();
  }, [reload]);

  // Deployment activity changes what Overview shows, so refresh on it.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as {
        projectSlug: string | null;
        state: string;
      };
      if (updated.projectSlug === slug && ['READY', 'ERROR', 'CANCELED'].includes(updated.state)) {
        void reload();
      }
    });
    return () => source.close();
  }, [slug, reload]);

  if (error) {
    return (
      <div className="container">
        <Alert kind="error">{error}</Alert>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="container">
        <Spinner label="Loading project…" />
      </div>
    );
  }

  return (
    <div className="project-shell">
      <aside className="sidebar">
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.label}
              end={item.end}
              to={`/projects/${project.slug}${item.to ? `/${item.to}` : ''}`}
              className={({ isActive }) =>
                isActive ? 'side-link active' : 'side-link'
              }
            >
              <NavIcon path={item.path} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="project-main">
        <Outlet context={{ project, reload }} />
      </main>
    </div>
  );
}
