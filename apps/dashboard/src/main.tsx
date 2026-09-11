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
import { api, type User } from './api.ts';
import { AuthContext } from './auth.ts';
import { DeploymentPage } from './pages/DeploymentPage.tsx';
import { GitSettings } from './pages/GitSettings.tsx';
import { Login } from './pages/Login.tsx';
import { NewProject } from './pages/NewProject.tsx';
import { Overview } from './pages/Overview.tsx';
import { ProjectPage } from './pages/ProjectPage.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import './styles.css';

function Topbar({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const initials = (user.name ?? user.email)
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');

  return (
    <header className="topbar">
      <NavLink to="/" className="brand">
        <span className="mark">▲</span>
        <span>
          Avail <small>Deploy</small>
        </span>
      </NavLink>
      <nav>
        <NavLink to="/" end>
          Overview
        </NavLink>
        <NavLink to="/new">Add New</NavLink>
        <NavLink to="/settings/git">Git</NavLink>
      </nav>
      <div className="spacer" />
      <span className="small muted" title={user.email}>
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

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
  }, []);

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
        <Topbar user={user} onSignOut={signOut} />
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/new" element={<NewProject />} />
          <Route path="/settings/git" element={<GitSettings />} />
          <Route path="/projects/:slug" element={<ProjectPage />} />
          <Route
            path="/projects/:slug/settings"
            element={<ProjectSettings />}
          />
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
