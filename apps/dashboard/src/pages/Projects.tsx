import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Deployment, type Project } from '../api.ts';
import {
  EmptyState,
  Spinner,
  StatusBadge,
  TimeAgo,
} from '../components/ui.tsx';
import { useAuth } from '../auth.ts';

const RECENT_PREVIEWS = 5;
const HOME_PROJECT_LIMIT = 3;

type ViewMode = 'grid' | 'list';
type Scope = 'all' | 'mine';

/** Most recent activity on a project — a fresh deploy counts more than an old edit. */
function activityTime(project: Project): number {
  return project.latestDeployment?.createdAt ?? project.updatedAt;
}

function readStoredView(): ViewMode {
  try {
    return localStorage.getItem('avail:projects-view') === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * Shared by both `/` (every project in the workspace) and `/myprojects`
 * (only the ones the signed-in user created) — identical layout, just a
 * different slice of the same data. Ownership is `createdBy`, the same
 * field the server already uses to gate deleting a project.
 */
export function ProjectsView({ scope }: { scope: Scope }) {
  const { user } = useAuth();
  const [allProjects, setAllProjects] = useState<Project[] | null>(null);
  const [allDeployments, setAllDeployments] = useState<Deployment[]>([]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>(readStoredView);

  function changeView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem('avail:projects-view', next);
    } catch {
      /* storage unavailable */
    }
  }

  async function load() {
    const [p, d] = await Promise.all([
      api.projects().catch(() => ({ projects: [] })),
      api.deployments(RECENT_PREVIEWS).catch(() => ({ deployments: [] })),
    ]);
    setAllProjects(p.projects);
    setAllDeployments(d.deployments);
  }

  useEffect(() => {
    void load();
  }, []);

  const mine = scope === 'mine';
  const projects = allProjects && mine ? allProjects.filter((p) => p.createdBy?.id === user.id) : allProjects;
  const projectIds = new Set((projects ?? []).map((p) => p.id));
  const deployments = mine ? allDeployments.filter((d) => projectIds.has(d.projectId)) : allDeployments;

  // Live deployment updates for the whole workspace, filtered down to just
  // this scope's own projects on the "mine" page.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as Deployment;
      setAllDeployments((current) => {
        const rest = current.filter((d) => d.id !== updated.id);
        return [updated, ...rest].slice(0, RECENT_PREVIEWS);
      });
      setAllProjects((current) =>
        current
          ? current.map((project) =>
              project.id === updated.projectId
                ? {
                    ...project,
                    latestDeployment: updated,
                    productionDeployment: updated.isCurrentProduction
                      ? updated
                      : project.productionDeployment,
                  }
                : project
            )
          : current
      );
    });
    return () => source.close();
  }, []);

  if (!projects) {
    return <Spinner label="Loading projects…" />;
  }

  const sortedByRecency = [...projects].sort(
    (a, b) => activityTime(b) - activityTime(a)
  );

  const matches = query
    ? sortedByRecency.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.slug.includes(query.toLowerCase())
      )
    : sortedByRecency;

  // A search names something specific, so show every match; browsing without
  // one gets a glance at the most recently active projects instead of the
  // whole list.
  const filtered = query ? matches : matches.slice(0, HOME_PROJECT_LIMIT);

  const title = mine ? 'My Projects' : 'All Projects';

  return (
    <>
      <div className="page-head">
        <div className="stack">
          <h1>{title}</h1>
          <span className="sub">
            {filtered.length}
            {filtered.length !== projects.length ? ` of ${projects.length}` : ''}{' '}
            project{projects.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="spacer" />
        <div className="log-search" style={{ flex: 'none', width: 260 }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            placeholder="Search Projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="view-toggle" role="group" aria-label="View">
          <button
            type="button"
            className={view === 'grid' ? 'active' : ''}
            aria-pressed={view === 'grid'}
            title="Grid view"
            onClick={() => changeView('grid')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <button
            type="button"
            className={view === 'list' ? 'active' : ''}
            aria-pressed={view === 'list'}
            title="List view"
            onClick={() => changeView('list')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <Link className="btn primary" to="/new">
          Add New
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="card">
          <EmptyState
            title={mine ? "You haven't created any projects yet" : 'No projects yet'}
            description={
              mine
                ? 'Projects you import will show up here — other projects in the workspace stay on All Projects.'
                : 'Import a Git repository to create your first deployment.'
            }
            action={
              <Link className="btn primary" to="/new">
                Import Git Repository
              </Link>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No matching projects"
            description={`No project names or repositories match “${query}”.`}
          />
        </div>
      ) : view === 'grid' ? (
        <div className="grid">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="list">
            {filtered.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </div>
        </div>
      )}

      {deployments.length > 0 ? (
        <div className="card" style={{ marginTop: 32 }}>
          <div className="card-head">
            <h2>Recent previews</h2>
            <div className="spacer" />
            <Link className="small link" to="/deployments">
              View all →
            </Link>
          </div>
          <div className="list">
            {deployments.map((deployment) => (
              <Link
                key={deployment.id}
                className="list-item"
                to={`/projects/${deployment.projectSlug}/deployments/${deployment.id}`}
              >
                <StatusBadge state={deployment.state} />
                <div className="stack" style={{ flex: 1 }}>
                  <div className="ellipsis">
                    <strong>{deployment.projectName}</strong>{' '}
                    <span className="faint small">{deployment.host}</span>
                  </div>
                  <div className="small faint ellipsis">
                    {deployment.commit?.message ?? deployment.branch}
                  </div>
                </div>
                <span className="small faint">
                  <TimeAgo value={deployment.createdAt} />
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function Projects() {
  return <ProjectsView scope="all" />;
}

function ProjectCard({ project }: { project: Project }) {
  const deployment = project.productionDeployment ?? project.latestDeployment;
  return (
    <Link className="project-card" to={`/projects/${project.slug}`}>
      <div className="row">
        <div className="stack" style={{ flex: 1 }}>
          <strong className="ellipsis">{project.name}</strong>
          <span className="small faint ellipsis">
            {project.repo?.fullName ?? 'no repository'}
          </span>
        </div>
        {deployment ? <StatusBadge state={deployment.state} /> : null}
      </div>

      <div
        className="small"
        style={{ marginTop: 14, color: 'var(--accent-hover)' }}
      >
        {project.productionUrl.replace(/^https?:\/\//, '')}
      </div>

      {deployment ? (
        <div className="stack small faint" style={{ marginTop: 12 }}>
          <span className="ellipsis">
            {deployment.commit?.message ?? 'No commit metadata'}
          </span>
          <span>
            <TimeAgo value={deployment.createdAt} /> on{' '}
            {deployment.branch ?? project.productionBranch}
          </span>
        </div>
      ) : (
        <div className="small faint" style={{ marginTop: 12 }}>
          No deployments yet
        </div>
      )}
    </Link>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const deployment = project.productionDeployment ?? project.latestDeployment;
  const initial = project.name.slice(0, 1).toUpperCase() || 'P';
  return (
    <Link className="list-item" to={`/projects/${project.slug}`}>
      <span className="switcher-mark" aria-hidden>
        {initial}
      </span>
      <div className="stack" style={{ flex: 1 }}>
        <div className="ellipsis">
          <strong>{project.name}</strong>{' '}
          <span className="faint small">
            {project.productionUrl.replace(/^https?:\/\//, '')}
          </span>
        </div>
        <div className="small faint ellipsis">
          {deployment
            ? `${deployment.commit?.message ?? 'No commit metadata'} · ${
                deployment.branch ?? project.productionBranch
              }`
            : project.repo?.fullName ?? 'No deployments yet'}
        </div>
      </div>
      {deployment ? <StatusBadge state={deployment.state} /> : null}
      <span className="small faint" style={{ minWidth: 64, textAlign: 'right' }}>
        {deployment ? <TimeAgo value={deployment.createdAt} /> : '—'}
      </span>
    </Link>
  );
}
