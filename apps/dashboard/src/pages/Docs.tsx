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
            environment variables and domains, transferring ownership,
            notifications, account settings, and who's allowed to do what.
          </span>
        </div>
      </div>

      <div className="docs-article">
        <section className="docs-section">
          <h2>Dashboard layout</h2>
          <p className="sub">
            Two shells share the same sidebar shape. The workspace{' '}
            <strong>home</strong> (opened from the <strong>Avail Deploy</strong>{' '}
            logo, or the project switcher's <strong>All Projects</strong>{' '}
            entry) has <strong>All Projects</strong> and{' '}
            <strong>My Projects</strong> (the same list, filtered to what you
            created) plus Deployments/Logs/Environment Variables/Domains/
            Settings, each showing that resource across <em>every</em>{' '}
            project — Environment Variables and Domains are read-only there,
            since a variable or domain always belongs to one project. A{' '}
            <strong>project's own shell</strong> starts with a{' '}
            <strong>Home</strong> link back to the workspace, then the same
            tabs scoped to just that project, with full editing.
          </p>

          <div className="docs-two-up">
            <div>
              <Frame url="avail.localhost/">
                <SidebarMockup active="All Projects" variant="home" />
              </Frame>
              <p className="docs-caption">Workspace home</p>
            </div>
            <div>
              <Frame url="avail.localhost/projects/my-app">
                <SidebarMockup active="Overview" variant="project" />
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
            <strong>admin</strong>; everyone else who signs in afterward
            joins as a <strong>member</strong>. There's no invite step and no
            separate roles to assign — it's decided automatically by who
            got there first.
          </p>
          <p className="sub">
            Admin and member can do almost everything the same way: create
            projects, deploy, edit environment variables, manage domains and
            webhooks, comment on deployments. The split only matters for two
            actions that can't be undone —{' '}
            <strong>deleting a project</strong> and{' '}
            <strong>removing a custom domain</strong>. Either needs the
            admin, or specifically whoever created that project — a member
            can always clean up their own project, but can't touch one
            someone else on the workspace created. The{' '}
            <strong>Delete project</strong> button is disabled up front for
            anyone who doesn't qualify (with a tooltip explaining why),
            rather than only refusing after the fact — though the server
            still enforces the same rule regardless of what the button
            shows.
          </p>
          <p className="sub">
            <strong>Transferring ownership is stricter still</strong> —
            unlike deleting, the admin gets no override. Only a project's
            current creator can offer it to someone else; see{' '}
            <strong>Transfer ownership</strong> below.
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
            <strong>admin</strong>, or whoever created this particular
            project — see <strong>Access control</strong> above; anyone else
            sees the button disabled outright. Removing a custom domain from
            a project's <strong>Domains</strong> tab follows the same rule.
          </p>
          <p className="sub">
            Clicking it doesn't delete anything by itself — it opens a
            confirmation screen in the same spot asking you to{' '}
            <strong>type the project's name</strong> before{' '}
            <strong>Confirm Delete</strong> will even enable, so this one
            can't happen from a stray click.
          </p>

          <Frame url="avail.localhost/projects/my-app/settings">
            <DangerZoneMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Transfer ownership</h2>
          <p className="sub">
            A project's current creator (only — see{' '}
            <strong>Access control</strong> above) can hand it to another
            workspace member from that same Settings page: pick who from{' '}
            <strong>New owner</strong> and click{' '}
            <strong>Transfer ownership</strong>. Nothing happens to the
            project yet — it just sends the recipient a notification with{' '}
            <strong>Accept</strong> / <strong>Decline</strong>, and only{' '}
            <strong>Accept</strong> actually changes who it's created by.
          </p>
          <p className="sub">
            While it's waiting on them, the sender's Settings page shows{' '}
            <strong>Transfer in progress</strong> in place of the transfer
            form, with a <strong>Cancel</strong> button right next to it —
            pulling the request back at any point before they respond, no
            explanation needed.
          </p>

          <div className="docs-two-up">
            <div>
              <Frame url="avail.localhost/projects/my-app/settings">
                <TransferPendingMockup />
              </Frame>
              <p className="docs-caption">Sender's view, while pending</p>
            </div>
            <div>
              <Frame url="notifications">
                <TransferNotificationMockup />
              </Frame>
              <p className="docs-caption">Recipient's notification</p>
            </div>
          </div>
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
          <h2>Notifications</h2>
          <p className="sub">
            The bell icon in the top bar, between <strong>Git</strong> and
            your avatar, is every notification aimed at you — it covers
            everything above that happens to a project you created:
          </p>
          <ul className="docs-steps">
            <li>An ownership transfer request, with Accept/Decline right in the list, and the outcome once you (or they) respond</li>
            <li>One of your deployments going <strong>Ready</strong> or failing</li>
            <li>A comment on one of your projects</li>
            <li>A push that triggered a build — not a redeploy you clicked yourself, just ones GitHub set off on its own</li>
          </ul>
          <p className="sub">
            Unread ones carry a dot and a badge on the bell;{' '}
            <strong>Mark all read</strong> clears both without acting on any
            of them. Clicking a notification (other than a still-pending
            transfer request) marks it read and jumps to the project or
            deployment it's about.
          </p>

          <Frame url="notifications">
            <NotificationsMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Account menu</h2>
          <p className="sub">
            The avatar in the top-right corner opens theme (system, light or
            dark), <strong>Account settings</strong>,{' '}
            <strong>Home Page</strong> (the Avail Project site) and this{' '}
            <strong>Docs</strong> page — the latter two open in a new tab —
            and <strong>Sign out</strong>.
          </p>

          <Frame url="account">
            <AccountMenuMockup />
          </Frame>
        </section>

        <section className="docs-section">
          <h2>Account settings</h2>
          <p className="sub">
            Reached from the account menu above, or{' '}
            <code>/settings/account</code> directly. Two things live here:
          </p>
          <p className="sub">
            <strong>Password.</strong> Optional, and separate from the
            emailed sign-in code — collapsed behind a single{' '}
            <strong>Create Password</strong> button until you click it. Once
            set, logging in with that email jumps straight to a password
            prompt instead of waiting on a code; the button here becomes{' '}
            <strong>Update Password</strong>, which asks for the current one
            first. Every password needs 8+ characters, an uppercase and
            lowercase letter, and a special character — every password field
            has an eye icon to reveal what you typed.
          </p>
          <p className="sub">
            <strong>Forgot password?</strong> on the sign-in screen is a real
            reset, not just a fallback to the emailed code: re-enter the
            email, send a 6-digit code, verify it, then set a brand-new
            password on its own screen — an account can never be locked out
            by setting one. The confirm step is gated by a short-lived signed
            token (not a session) that expires <strong>5 minutes</strong>{' '}
            after the code is verified; finishing the wizard returns you to
            the sign-in screen to log in fresh with the new password rather
            than signing you in automatically.
          </p>
          <p className="sub">
            <strong>Delete account.</strong> Two-step, same as deleting a
            project — permanently removes the account, signs it out
            everywhere, and disconnects any GitHub account it had connected.
            Refused outright while it still owns any project; transfer or
            delete those first.
          </p>

          <Frame url="avail.localhost/settings/account">
            <AccountSettingsMockup />
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

// The two shells' item lists no longer line up one-to-one (Home only makes
// sense inside a project, My Projects only at the workspace level), so
// each variant is its own list rather than one row mapped two ways.
const HOME_SIDEBAR = ['All Projects', 'My Projects', 'Deployments', 'Logs', 'Environment Variables', 'Domains', 'Settings'];
const PROJECT_SIDEBAR = ['Home', 'Overview', 'Deployments', 'Logs', 'Environment Variables', 'Domains', 'Settings'];

function SidebarMockup({
  active,
  variant,
}: {
  active: string;
  variant: 'home' | 'project';
}) {
  const items = variant === 'home' ? HOME_SIDEBAR : PROJECT_SIDEBAR;
  return (
    <nav className="docs-sidebar-mock">
      {items.map((label) => (
        <div
          key={label}
          className={`side-link${label === active ? ' active' : ''}`}
        >
          <span className="docs-dot-icon" />
          {label}
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
        This action is <strong>permanent and cannot be undone</strong>.
        Deleting <strong>my-app</strong> removes the project itself along
        with every deployment, build artifact, environment variable, and
        domain attached to it.
        <div className="field" style={{ marginTop: 10 }}>
          <label>
            Type <code>my-app</code> to confirm
          </label>
          <span className="input" style={{ display: 'block' }}>
            my-app
          </span>
        </div>
      </div>
      <div className="card-foot">
        <span className="btn danger">Confirm Delete</span>
        <span className="btn ghost">Cancel</span>
      </div>
    </div>
  );
}

function TransferPendingMockup() {
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="card-head">
        <h2>Transfer ownership</h2>
      </div>
      <div className="card-body muted small">
        Waiting on <strong>teammate</strong> to accept. They'll see a
        notification with Accept/Decline — nothing changes until they
        respond, and you can pull the request back any time before then.
      </div>
      <div className="card-foot">
        <span className="btn">Transfer in progress</span>
        <span className="btn ghost">Cancel</span>
      </div>
    </div>
  );
}

function TransferNotificationMockup() {
  return (
    <div
      className="notif-panel"
      style={{ position: 'static', width: '100%', boxShadow: 'none', border: 'none' }}
    >
      <div className="notif-panel-head">
        <h3>Notifications</h3>
      </div>
      <div className="notif-list">
        <div className="notif-item unread">
          <span className="notif-dot" aria-hidden />
          <div className="notif-item-body">
            <div className="notif-item-title">
              anuj@availproject.org wants to transfer my-app to you
            </div>
            <div className="notif-item-detail">
              Accept to take over as its creator, or decline.
            </div>
            <div className="notif-item-actions">
              <span className="btn sm primary">Accept</span>
              <span className="btn sm ghost">Decline</span>
            </div>
          </div>
        </div>
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
        <span className="btn sm">admin</span>
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
      <div className="account-row">👤 Account settings</div>
      <div className="account-row">🏠 Home Page</div>
      <div className="account-row">📄 Docs</div>
      <div className="account-row danger">⇥ Sign out</div>
    </div>
  );
}

function NotificationsMockup() {
  return (
    <div
      className="notif-panel"
      style={{ position: 'static', width: '100%', boxShadow: 'none', border: 'none' }}
    >
      <div className="notif-panel-head">
        <h3>Notifications</h3>
        <div className="spacer" />
        <span className="small link">Mark all read</span>
      </div>
      <div className="notif-list">
        <div className="notif-item unread">
          <span className="notif-dot" aria-hidden />
          <div className="notif-item-body">
            <div className="notif-item-title">
              anuj@availproject.org wants to transfer my-app to you
            </div>
            <div className="notif-item-detail">
              Accept to take over as its creator, or decline.
            </div>
            <div className="notif-item-actions">
              <span className="btn sm primary">Accept</span>
              <span className="btn sm ghost">Decline</span>
            </div>
          </div>
        </div>
        <div className="notif-item unread">
          <span className="notif-dot" aria-hidden />
          <div className="notif-item-body">
            <div className="notif-item-title">my-app is ready</div>
            <div className="notif-item-detail">my-app.avail.localhost:3002</div>
          </div>
        </div>
        <div className="notif-item">
          <span style={{ width: 7, flex: 'none' }} />
          <div className="notif-item-body">
            <div className="notif-item-title">teammate commented on my-app</div>
            <div className="notif-item-detail">
              Looks good — approving this preview.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountSettingsMockup() {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card" style={{ margin: 0 }}>
        <div className="card-head">
          <h2>Password</h2>
        </div>
        <div className="card-body muted small">
          Create a password so you can sign in with your email address
          instead of waiting on a one-time code each time.
        </div>
        <div className="card-foot">
          <span className="btn primary">Create Password</span>
        </div>
      </div>
      <div className="card" style={{ margin: 0 }}>
        <div className="card-head">
          <h2 style={{ color: 'var(--danger)' }}>Delete account</h2>
        </div>
        <div className="card-body muted small">
          Permanently deletes your account, signs you out everywhere, and
          disconnects any GitHub account you connected.
        </div>
        <div className="card-foot">
          <span className="btn danger">Delete account</span>
        </div>
      </div>
    </div>
  );
}
