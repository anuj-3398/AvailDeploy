import React, { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { api, type Project, type User } from './api.ts';
import { AuthContext } from './auth.ts';
import { ProjectLayout } from './components/ProjectLayout.tsx';
import { ProjectSwitcher } from './components/ProjectSwitcher.tsx';
import { Spinner } from './components/ui.tsx';
import { DeploymentPage } from './pages/DeploymentPage.tsx';
import { GitSettings } from './pages/GitSettings.tsx';
import { Login } from './pages/Login.tsx';
import { NewProject } from './pages/NewProject.tsx';
import { ProjectDeployments } from './pages/ProjectDeployments.tsx';
import { ProjectLogs } from './pages/ProjectLogs.tsx';
import { ProjectOverview } from './pages/ProjectOverview.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import { Projects } from './pages/Projects.tsx';
import './styles.css';
import './shell.css';

function Topbar({
  user,
  onSignOut,
  projects,
  current,
}: {
  user: User;
  onSignOut: () => void;
  projects: Project[];
  current: Project | null;
}) {
  const initials = (user.name ?? user.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <span className="mark">▲</span>
        <span>
          Avail <small>Deploy</small>
        </span>
      </NavLink>

      <span className="topbar-sep" aria-hidden>
        /
      </span>
      <ProjectSwitcher projects={projects} current={current} />

      <div className="spacer" />

      <NavLink to="/settings/git" className="topbar-link">
        Git
      </NavLink>
      <span className="small muted hide-sm" title={user.email}>
        {user.email}
      </span>
      <div className="avatar" aria-hidden>
        {initials}
      </div>
      <button className="btn sm ghost" onClick={onSignOut}>
        Sign out
      </button>
    </header>
  );
}

/** Sends `/` to the most recently updated project, or to the import flow. */
function Home({ projects }: { projects: Project[] | null }) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!projects) return;
    navigate(projects.length ? `/projects/${projects[0].slug}` : '/new', {
      replace: true,
    });
  }, [projects, navigate]);

  return (
    <div className="container">
      <Spinner label="Loading…" />
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [current, setCurrent] = useState<Project | null>(null);
  const location = useLocation();

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api.me();
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const { projects: rows } = await api.projects();
      setProjects(rows);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (user) void loadProjects();
  }, [user, loadProjects]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
    setProjects(null);
    setCurrent(null);
  }, []);

  // A project loaded by the project shell also names the switcher.
  const onProjectLoaded = useCallback(
    (project: Project | null) => {
      setCurrent(project);
      if (project) {
        setProjects((rows) =>
          rows?.some((p) => p.id === project.id)
            ? rows.map((p) => (p.id === project.id ? project : p))
            : rows
              ? [project, ...rows]
              : rows
        );
      }
    },
    []
  );

  if (loading) {
    return (
      <div className="center-note">
        <div className="row" style={{ justifyContent: 'center' }}>
          <span className="spinner" /> Loading…
        </div>
      </div>
    );
  }

  if (!user) {
    if (location.pathname !== '/login') {
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return <Login onSignedIn={setUser} />;
  }

  return (
    <AuthContext.Provider value={{ user, refresh, signOut }}>
      <div className="shell">
        <Topbar
          user={user}
          onSignOut={signOut}
          projects={projects ?? []}
          current={current}
        />
        <Routes>
          <Route path="/" element={<Home projects={projects} />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/new" element={<NewProject />} />
          <Route path="/settings/git" element={<GitSettings />} />

          <Route
            path="/projects/:slug"
            element={<ProjectLayout onProjectLoaded={onProjectLoaded} />}
          >
            <Route index element={<ProjectOverview />} />
            <Route path="deployments" element={<ProjectDeployments />} />
            <Route path="logs" element={<ProjectLogs />} />
            <Route path="settings" element={<ProjectSettings />} />
            <Route path="settings/:tab" element={<ProjectSettings />} />
          </Route>

          <Route
            path="/projects/:slug/deployments/:id"
            element={<DeploymentPage />}
          />

          <Route
            path="*"
            element={
              <div className="container">
                <div className="empty">
                  <h2>Page not found</h2>
                  <NavLink className="btn" to="/">
                    Back to overview
                  </NavLink>
                </div>
              </div>
            }
          />
        </Routes>
      </div>
    </AuthContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
