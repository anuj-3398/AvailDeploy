import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Deployment, type Project } from '../api.ts';
import {
  EmptyState,
  Spinner,
  StatusBadge,
  TimeAgo,
} from '../components/ui.tsx';

export function Overview() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [query, setQuery] = useState('');

  async function load() {
    const [p, d] = await Promise.all([
      api.projects().catch(() => ({ projects: [] })),
      api.deployments(12).catch(() => ({ deployments: [] })),
    ]);
    setProjects(p.projects);
    setDeployments(d.deployments);
  }

  useEffect(() => {
    void load();
  }, []);

  // Live deployment updates for the whole workspace.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('deployment', (event) => {
      const updated = JSON.parse((event as MessageEvent).data) as Deployment;
      setDeployments((current) => {
        const rest = current.filter((d) => d.id !== updated.id);
        return [updated, ...rest].slice(0, 12);
      });
      setProjects((current) =>
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
    return (
      <div className="container">
        <Spinner label="Loading projects…" />
      </div>
    );
  }

  const filtered = query
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          p.slug.includes(query.toLowerCase())
      )
    : projects;

  return (
    <div className="container wide">
      <div className="page-head">
        <div className="stack">
          <h1>Overview</h1>
          <span className="sub">
            {projects.length} project{projects.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="spacer" />
        <input
          className="input"
          style={{ maxWidth: 240 }}
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Link className="btn primary" to="/new">
          Add New
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No projects yet"
            description="Import a Git repository to create your first deployment."
            action={
              <Link className="btn primary" to="/new">
                Import Git Repository
              </Link>
            }
          />
        </div>
      ) : (
        <div className="grid">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}

      {deployments.length > 0 ? (
        <div className="card" style={{ marginTop: 32 }}>
          <div className="card-head">
            <h2>Recent deployments</h2>
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
    </div>
  );
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
