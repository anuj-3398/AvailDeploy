import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Project } from '../api.ts';
import { Alert, NavIcon, Spinner, navIcons } from '../components/ui.tsx';
import { useProjects } from '../projects.ts';

const NAV = [
  { to: '', label: 'Overview', path: navIcons.overview, end: true },
  { to: 'deployments', label: 'Deployments', path: navIcons.deployments },
  { to: 'logs', label: 'Logs', path: navIcons.logs },
  { to: 'settings/env', label: 'Environment Variables', path: navIcons.env },
  { to: 'settings/domains', label: 'Domains', path: navIcons.domains },
  // `end` so Settings is not also highlighted while a sub-tab is open.
  { to: 'settings', label: 'Settings', path: navIcons.settings, end: true },
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
  const navigate = useNavigate();
  const { removeBySlug } = useProjects();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const { project: loaded } = await api.project(slug);
      setProject(loaded);
      onProjectLoaded(loaded);
      setError('');
    } catch (err) {
      setProject(null);
      onProjectLoaded(null);

      // The project is gone — deleted here, or from another tab. Drop it from
      // the shared list and move on rather than stranding the user on a dead
      // URL that the switcher still lists.
      if (err instanceof ApiError && err.status === 404) {
        removeBySlug(slug);
        navigate('/', { replace: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load project');
    }
  }, [slug, onProjectLoaded, removeBySlug, navigate]);

  useEffect(() => {
    setProject(null);
    void reload();
  }, [reload]);

  // Deployment activity changes what Overview shows — a build starting is
  // exactly when it needs to switch away from "no production deployment
  // yet" to an in-progress view, not just when one finishes — so refresh on
  // every state this project's deployments pass through, not only the
  // terminal ones.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as {
        projectSlug: string | null;
      };
      if (updated.projectSlug === slug) {
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
