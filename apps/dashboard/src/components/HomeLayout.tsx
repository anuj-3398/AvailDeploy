import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { NavIcon, navIcons } from '../components/ui.tsx';

const NAV = [
  { to: '', label: 'All Projects', path: navIcons.overview, end: true },
  { to: 'myprojects', label: 'My Projects', path: navIcons.mine },
  { to: 'deployments', label: 'Deployments', path: navIcons.deployments },
  { to: 'logs', label: 'Logs', path: navIcons.logs },
  { to: 'env', label: 'Environment Variables', path: navIcons.env },
  { to: 'domains', label: 'Domains', path: navIcons.domains },
  { to: 'settings/git', label: 'Settings', path: navIcons.settings, end: true },
];

/**
 * The workspace-level shell shown at `/`: the same sidebar shape as a
 * project's own shell (see ProjectLayout), but scoped to every project
 * instead of one.
 */
export function HomeLayout() {
  return (
    <div className="project-shell">
      <aside className="sidebar">
        <nav>
          {NAV.map((item) => (
            <NavLink
              key={item.label}
              end={item.end}
              to={`/${item.to}`}
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
        <Outlet />
      </main>
    </div>
  );
}
