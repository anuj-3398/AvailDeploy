import React, { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { api, type Project, type User } from './api.ts';
import { AuthContext } from './auth.ts';
import { ProjectsContext } from './projects.ts';
import { AccountMenu } from './components/AccountMenu.tsx';
import { HomeLayout } from './components/HomeLayout.tsx';
import { ProjectLayout } from './components/ProjectLayout.tsx';
import { ProjectSwitcher } from './components/ProjectSwitcher.tsx';
import { Logo } from './components/ui.tsx';
import { applyTheme, getStoredTheme } from './theme.ts';
import { AllDeployments } from './pages/AllDeployments.tsx';
import { AllDomains } from './pages/AllDomains.tsx';
import { AllEnvVars } from './pages/AllEnvVars.tsx';
import { AllLogs } from './pages/AllLogs.tsx';
import { DeploymentPage } from './pages/DeploymentPage.tsx';
import { Docs } from './pages/Docs.tsx';
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
  const location = useLocation();

  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <Logo size={20} />
        <span>
          Avail <small>Deploy</small>
        </span>
      </NavLink>

      <span className="topbar-sep" aria-hidden>
        /
      </span>
      {location.pathname === '/docs' ? (
        <span className="topbar-crumb">Docs</span>
      ) : (
        <ProjectSwitcher projects={projects} current={current} />
      )}

      <div className="spacer" />

      <NavLink to="/settings/git" className="topbar-link">
        Git
      </NavLink>
      <AccountMenu user={user} onSignOut={onSignOut} />
    </header>
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

  const upsertProject = useCallback((project: Project) => {
    setProjects((rows) => {
      if (!rows) return [project];
      return rows.some((p) => p.id === project.id)
        ? rows.map((p) => (p.id === project.id ? project : p))
        : [project, ...rows];
    });
  }, []);

  const removeProject = useCallback((projectId: string) => {
    setProjects((rows) => rows?.filter((p) => p.id !== projectId) ?? rows);
    setCurrent((p) => (p?.id === projectId ? null : p));
  }, []);

  const removeProjectBySlug = useCallback((slug: string) => {
    setProjects((rows) => rows?.filter((p) => p.slug !== slug) ?? rows);
    setCurrent((p) => (p?.slug === slug ? null : p));
  }, []);

  /** The project the user should land on once `projectId` is gone. */
  const nextSlugAfter = useCallback(
    (projectId: string) =>
      projects?.find((p) => p.id !== projectId)?.slug ?? null,
    [projects]
  );

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
      if (project) upsertProject(project);
    },
    [upsertProject]
  );

  // Outside a project's own routes there is no "current" project — the
  // switcher should read "All Projects" rather than keep naming whichever
  // project was last open.
  useEffect(() => {
    if (!location.pathname.startsWith('/projects/')) setCurrent(null);
  }, [location.pathname]);

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
      <ProjectsContext.Provider
        value={{
          projects: projects ?? [],
          loaded: projects !== null,
          reload: loadProjects,
          upsert: upsertProject,
          remove: removeProject,
          removeBySlug: removeProjectBySlug,
          nextSlugAfter,
        }}
      >
        <div className="shell">
          <Topbar
            user={user}
            onSignOut={signOut}
            projects={projects ?? []}
            current={current}
          />
          <Routes>
            <Route path="/" element={<HomeLayout />}>
              <Route index element={<Projects />} />
              <Route path="deployments" element={<AllDeployments />} />
              <Route path="logs" element={<AllLogs />} />
              <Route path="env" element={<AllEnvVars />} />
              <Route path="domains" element={<AllDomains />} />
              <Route path="settings/git" element={<GitSettings />} />
            </Route>
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/projects" element={<Navigate to="/" replace />} />
            <Route path="/new" element={<NewProject />} />
            <Route path="/docs" element={<Docs />} />

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
      </ProjectsContext.Provider>
    </AuthContext.Provider>
  );
}

// index.html already applies this inline, before first paint; repeating it
// here just keeps this module the single source of truth for the default.
applyTheme(getStoredTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
