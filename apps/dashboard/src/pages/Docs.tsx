import React from 'react';

/**
 * A self-contained walkthrough of the dashboard, reached from the account
 * menu. The screens below are drawn with the app's own CSS classes rather
 * than pasted-in screenshots, so they stay pixel-accurate as the real UI
 * changes and need no image assets to ship or keep up to date.
 */
export function Docs() {
  return (
    <div className="container">
      <div className="page-head">
        <div className="stack">
          <h1>Docs</h1>
          <span className="sub">
            Where every screen lives, and the steps for the flows you'll use
            most — creating, navigating and deleting projects, deployments,
            environment variables and domains, plus who's allowed to do what.
          </span>
        </div>
      </div>

      <div className="docs-article">
        <section className="docs-section">
          <h2>Dashboard layout</h2>
          <p className="sub">
            Two shells share the same six-tab sidebar. The workspace{' '}
            <strong>home</strong> (opened from the <strong>Avail Deploy</strong>{' '}
            logo, or the project switcher's <strong>All Projects</strong>{' '}
            entry) shows each tab's resource across{' '}
            <em>every</em> project — Environment Variables and Domains are
            read-only there, since a variable or domain always belongs to one
            project. A <strong>project's own shell</strong> shows the same six
            tabs scoped to just that project, with full editing.
          </p>

          <div className="docs-two-up">
            <div>
              <Frame url="avail.localhost/">
                <SidebarMockup active="overview" variant="home" />
              </Frame>
              <p className="docs-caption">Workspace home</p>
            </div>
            <div>
              <Frame url="avail.localhost/projects/my-app">
                <SidebarMockup active="overview" variant="project" />
              </Frame>
              <p className="docs-caption">A project's own shell</p>
            </div>
          </div>
        </section>

        <section className="docs-section">
          <h2>Creating a project</h2>
          <ol className="docs-steps">
            <li>
              <strong>Connect Git.</strong> Open the account menu's{' '}
              <strong>Settings</strong> (or the top bar's <strong>Git</strong>{' '}
              link) and click <strong>Connect with GitHub OAuth</strong> — or,
              if that's not set up on this install, paste a personal access
              token instead (there's a link for that right below the OAuth
              button). Signing in with GitHub in the first place skips this
              step entirely — it's already connected.
            </li>
            <li>
              Click <strong>Add New</strong> on the All Projects page, or{' '}
              <strong>+ Create Project</strong> in the project switcher.
            </li>
            <li>
              Pick a repository from the list, or switch to{' '}
              <strong>Git URL or local path</strong> to paste any git URL or a
              folder already on disk.
            </li>
            <li>
              Adjust the project settings if needed — production branch, root
              directory, install/build/output commands are all auto-detected
              by default — and paste any initial environment variables.
            </li>
            <li>
              Click <strong>Deploy</strong>. The first production deployment
              starts immediately and its build log streams live.
            </li>
          </ol>

          <div className="docs-two-up">
            <div>
              <Frame url="avail.localhost/settings/git">
                <GitConnectMockup />
              </Frame>
              <p className="docs-caption">Settings → Git</p>
            </div>
            <div>
              <Frame url="avail.localhost/new">
                <NewProjectMockup />
              </Frame>
              <p className="docs-caption">Add New</p>
            </div>
          </div>
        </section>

        <section className="docs-section">
          <h2>Navigating projects</h2>
          <p className="sub">
            The project switcher sits in the top bar, next to the logo.
            Search or click a project to jump straight to it;{' '}
            <strong>All Projects</strong> returns to the workspace home.
          </p>

          <Frame url="switcher">
            <SwitcherMockup />
          </Frame>

          <p className="sub" style={{ marginTop: 24 }}>
            A project's <strong>Overview</strong> tab is the production
            deployment at a glance: the live preview URL, domains, build
            status and commit, with <strong>Instant Rollback</strong> and{' '}
            <strong>Visit</strong> one click away.
          </p>

          <Frame url="avail.localhost/projects/my-app">
            <OverviewMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Access control</h2>
          <p className="sub">
            The first person to sign in becomes the workspace's{' '}
            <strong>owner</strong>; everyone else who signs in afterward
            joins as a <strong>member</strong>. There's no invite step and no
            separate roles to assign — it's decided automatically by who
            got there first.
          </p>
          <p className="sub">
            Owner and member can do almost everything the same way: create
            projects, deploy, edit environment variables, manage domains and
            webhooks, comment on deployments. The split only matters for two
            actions that can't be undone —{' '}
            <strong>deleting a project</strong> and{' '}
            <strong>removing a custom domain</strong>. Either needs the
            owner, or specifically whoever created that project — a member
            can always clean up their own project, but can't touch one
            someone else on the workspace created. Anyone else who tries
            either gets a plain "Only the workspace owner or whoever created
            this project can do this" response rather than a
            partially-completed action.
          </p>

          <Frame url="avail.localhost/projects/my-app/settings">
            <RoleMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>How deployments work</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Event</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Push to the production branch</td>
                <td>
                  A production deployment builds and replaces what's live.
                </td>
              </tr>
              <tr>
                <td>Push to any other branch, or open a pull request</td>
                <td>
                  A preview deployment builds with its own URL — production is
                  never touched.
                </td>
              </tr>
              <tr>
                <td>Instant Rollback, or Promote on a READY deployment</td>
                <td>Production swaps to that build instantly — no rebuild.</td>
              </tr>
              <tr>
                <td>Project has an Ignored Build Step, and it exits <code>0</code></td>
                <td>
                  The build stops right after checkout — nothing installs or
                  builds. The deployment lands <strong>Skipped</strong>.
                </td>
              </tr>
              <tr>
                <td>Build finishes (GitHub-connected project)</td>
                <td>
                  The commit gets a status check (building → ready/failed),
                  and a pull-request build also gets a "Deploy Preview ready"
                  comment on that PR.
                </td>
              </tr>
            </tbody>
          </table>
          <p className="sub" style={{ marginTop: 12 }}>
            A running build can be canceled, and an old deployment removed,
            from its own page or the project's <strong>Deployments</strong>{' '}
            tab. That page also has a <strong>Comments</strong> thread for
            leaving notes on that specific build — see below.
          </p>
        </section>

        <section className="docs-section">
          <h2>Environment variables &amp; domains</h2>
          <p className="sub">
            Add or remove either from a project's own Settings →{' '}
            <strong>Environment Variables</strong> /{' '}
            <strong>Domains</strong> tab. Variables are scoped to
            production/preview/development and optionally to one branch, and
            encrypted at rest — a value stays hidden until you click{' '}
            <strong>Reveal</strong>.
          </p>
          <p className="sub">
            The workspace-level Environment Variables and Domains tabs (in the
            home sidebar) list every project's at a glance for a bird's-eye
            view — read-only; click a row's project name to go make the
            change.
          </p>

          <Frame url="avail.localhost/env">
            <EnvTableMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Deleting a project</h2>
          <p className="sub">
            Open the project, go to <strong>Settings</strong> → General, and
            use <strong>Delete project</strong> at the bottom. It removes the
            project, every deployment and all build artifacts —{' '}
            <strong>this cannot be undone</strong>. Needs the workspace{' '}
            <strong>owner</strong>, or whoever created this particular
            project — see <strong>Access control</strong> above; anyone else
            sees the same button but the request is refused, with the
            reason shown right on the page. Removing a custom domain from a
            project's <strong>Domains</strong> tab follows the same rule.
          </p>

          <Frame url="avail.localhost/projects/my-app/settings">
            <DangerZoneMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Preview comments</h2>
          <p className="sub">
            Every deployment's own page has a comment thread underneath the
            build log — a place to leave a note ("approving this preview",
            "why did this fail") without leaving the dashboard. Anyone
            signed in can post; you can only delete your own.
          </p>

          <Frame url="avail.localhost/projects/my-app/deployments/dpl_…">
            <CommentsMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Account menu</h2>
          <p className="sub">
            The avatar in the top-right corner opens theme (system, light or
            dark), <strong>Home Page</strong> (the Avail Project site) and
            this <strong>Docs</strong> page — both open in a new tab — and{' '}
            <strong>Sign out</strong>.
          </p>

          <Frame url="account">
            <AccountMenuMockup />
          </Frame>
        </section>
      </div>
    </div>
  );
}

/* ============================================================== mockups === */
/* Decorative only — real classes for visual fidelity, no live interaction. */

function Frame({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <div className="docs-frame" aria-hidden="true">
      <div className="docs-frame-bar">
        <span className="docs-dot red" />
        <span className="docs-dot yellow" />
        <span className="docs-dot green" />
        <span className="docs-frame-url">{url}</span>
      </div>
      <div className="docs-frame-body">{children}</div>
    </div>
  );
}

const HOME_NAV = [
  { id: 'overview', home: 'All Projects', project: 'Overview' },
  { id: 'deployments', home: 'Deployments', project: 'Deployments' },
  { id: 'logs', home: 'Logs', project: 'Logs' },
  { id: 'env', home: 'Environment Variables', project: 'Environment Variables' },
  { id: 'domains', home: 'Domains', project: 'Domains' },
  { id: 'settings', home: 'Settings', project: 'Settings' },
];

function SidebarMockup({
  active,
  variant,
}: {
  active: string;
  variant: 'home' | 'project';
}) {
  return (
    <nav className="docs-sidebar-mock">
      {HOME_NAV.map((item) => (
        <div
          key={item.id}
          className={`side-link${item.id === active ? ' active' : ''}`}
        >
          <span className="docs-dot-icon" />
          {variant === 'home' ? item.home : item.project}
        </div>
      ))}
    </nav>
  );
}

function SwitcherMockup() {
  return (
    <div className="docs-panel">
      <div className="switcher-search">
        <span className="faint small">Find Project…</span>
      </div>
      <div className="switcher-list">
        <div className="switcher-item highlight">
          <span className="switcher-mark small">M</span>
          <span className="switcher-item-name">my-app</span>
        </div>
        <div className="switcher-item">
          <span className="switcher-mark small">D</span>
          <span className="switcher-item-name">docs-site</span>
        </div>
      </div>
      <div className="switcher-create">
        <span aria-hidden>▦</span> All Projects
      </div>
      <div className="switcher-create">
        <span aria-hidden>+</span> Create Project
      </div>
    </div>
  );
}

function GitConnectMockup() {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card" style={{ margin: 0 }}>
        <div className="card-head">
          <h2>Connected accounts</h2>
        </div>
        <div className="card-body muted small">
          No GitHub account is connected yet.
        </div>
        <div className="card-foot">
          <span className="btn accent">Connect with GitHub OAuth</span>
        </div>
      </div>
      <div className="card" style={{ margin: 0 }}>
        <div className="card-body" style={{ padding: 12 }}>
          <span className="btn ghost sm">
            Use a personal access token instead
          </span>
        </div>
      </div>
    </div>
  );
}

function NewProjectMockup() {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="list-item" style={{ background: 'var(--bg-hover)' }}>
        <span className="switcher-mark small">M</span>
        <div className="stack" style={{ flex: 1 }}>
          <span className="ellipsis">availproject/my-app</span>
          <span className="small faint">Private · pushed 2 hours ago</span>
        </div>
        <span className="btn sm primary">Selected</span>
      </div>
      <div className="list-item">
        <span className="switcher-mark small">D</span>
        <div className="stack" style={{ flex: 1 }}>
          <span className="ellipsis">availproject/docs-site</span>
          <span className="small faint">Public · pushed yesterday</span>
        </div>
        <span className="btn sm">Select</span>
      </div>
      <div className="row wrap" style={{ marginTop: 4 }}>
        <span className="btn primary">Deploy</span>
        <span className="btn ghost">Cancel</span>
      </div>
    </div>
  );
}

function OverviewMockup() {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <strong>Production Deployment</strong>
        <div className="spacer" />
        <span className="btn sm">Instant Rollback</span>
        <span className="btn sm primary">Visit</span>
      </div>
      <div
        className="hero-preview-inner"
        style={{ borderRadius: 8, padding: '28px 0' }}
      >
        <span className="hero-preview-domain">my-app.avail.localhost</span>
        <span className="hero-preview-hint">Open deployment ↗</span>
      </div>
      <div className="hero-status">
        <span className="badge ready">
          <span className="dot" /> Ready
        </span>
        <span className="faint small">built in 12.4s</span>
      </div>
    </div>
  );
}

function EnvTableMockup() {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Project</th>
          <th>Key</th>
          <th>Value</th>
          <th>Environment</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>my-app</td>
          <td className="mono">API_URL</td>
          <td className="mono faint">••••••••</td>
          <td>production</td>
        </tr>
        <tr>
          <td>docs-site</td>
          <td className="mono">ANALYTICS_KEY</td>
          <td className="mono faint">••••••••</td>
          <td>production · main</td>
        </tr>
      </tbody>
    </table>
  );
}

function DangerZoneMockup() {
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="card-head">
        <h2 style={{ color: 'var(--danger)' }}>Delete project</h2>
      </div>
      <div className="card-body muted small">
        Removes the project, its deployments and all build artifacts. This
        cannot be undone.
        <br />
        <span className="faint">Owner, or whoever created this project.</span>
      </div>
      <div className="card-foot">
        <span className="btn danger">Delete project</span>
      </div>
    </div>
  );
}

function RoleMockup() {
  return (
    <div className="list">
      <div className="list-item">
        <span className="avatar tiny" aria-hidden>
          A
        </span>
        <div className="stack" style={{ flex: 1 }}>
          <strong>anuj@availproject.org</strong>
          <span className="small faint">Signed in first</span>
        </div>
        <span className="btn sm">owner</span>
      </div>
      <div className="list-item">
        <span className="avatar tiny" aria-hidden>
          T
        </span>
        <div className="stack" style={{ flex: 1 }}>
          <strong>teammate@availproject.org</strong>
          <span className="small faint">Signed in afterward</span>
        </div>
        <span className="btn sm ghost">member</span>
      </div>
    </div>
  );
}

function CommentsMockup() {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="comment">
        <span className="avatar tiny" aria-hidden>
          A
        </span>
        <div className="comment-body">
          <div className="comment-head">
            <strong>anuj</strong>
            <span className="small faint">2 minutes ago</span>
          </div>
          <p>Looks good — approving this preview.</p>
        </div>
      </div>
      <div className="comment">
        <span className="avatar tiny" aria-hidden>
          T
        </span>
        <div className="comment-body">
          <div className="comment-head">
            <strong>teammate</strong>
            <span className="small faint">just now</span>
          </div>
          <p>Nice, the pricing page loads fast now.</p>
        </div>
      </div>
      <div className="comment-form">
        <span className="textarea faint" style={{ flex: 1 }}>
          Leave a comment on this deployment…
        </span>
        <span className="btn">Comment</span>
      </div>
    </div>
  );
}

function AccountMenuMockup() {
  return (
    <div className="docs-panel">
      <div className="account-header">
        <strong>Jordan Lee</strong>
        <span className="small faint">jordan@availproject.org</span>
      </div>
      <div className="account-row static">
        <span>Theme</span>
        <div className="view-toggle">
          <span>◧</span>
          <span className="active">☀</span>
          <span>☾</span>
        </div>
      </div>
      <div className="account-row">🏠 Home Page</div>
      <div className="account-row">📄 Docs</div>
      <div className="account-row danger">⇥ Sign out</div>
    </div>
  );
}
