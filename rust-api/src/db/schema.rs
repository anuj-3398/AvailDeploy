//! Verbatim copy of `packages/db/src/schema.ts`'s `SCHEMA` constant. Must
//! stay byte-identical to it — whichever process (this one, the Node API,
//! the proxy, the builder) boots first creates the file the others open.
//! If a table is ever added or changed there, mirror it here in the same
//! commit.

pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'member',
  created_at   INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

CREATE TABLE IF NOT EXISTS git_integrations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL DEFAULT 'github',
  kind        TEXT NOT NULL DEFAULT 'pat',
  login       TEXT NOT NULL,
  avatar_url  TEXT,
  token_enc   TEXT NOT NULL,
  scopes      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_integrations_user ON git_integrations(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  framework          TEXT,
  root_directory     TEXT,
  install_command    TEXT,
  build_command      TEXT,
  output_directory   TEXT,
  dev_command        TEXT,
  node_version       TEXT NOT NULL DEFAULT '22.x',
  serve_mode         TEXT,
  repo_provider      TEXT,
  repo_full_name     TEXT,
  repo_id            TEXT,
  repo_default_branch TEXT,
  production_branch  TEXT NOT NULL DEFAULT 'main',
  auto_deploy        INTEGER NOT NULL DEFAULT 1,
  preview_deploys    INTEGER NOT NULL DEFAULT 1,
  git_integration_id TEXT REFERENCES git_integrations(id) ON DELETE SET NULL,
  webhook_secret     TEXT,
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS env_vars (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value_enc  TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT 'production',
  git_branch TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_env_project ON env_vars(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_env_unique
  ON env_vars(project_id, key, target, IFNULL(git_branch, ''));

CREATE TABLE IF NOT EXISTS deployments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state           TEXT NOT NULL,
  target          TEXT NOT NULL,
  source          TEXT NOT NULL,
  branch          TEXT,
  commit_sha      TEXT,
  commit_message  TEXT,
  commit_author   TEXT,
  commit_url      TEXT,
  pr_number       INTEGER,
  url             TEXT NOT NULL,
  framework       TEXT,
  serve_mode      TEXT,
  start_command   TEXT,
  output_path     TEXT,
  error           TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  building_at     INTEGER,
  ready_at        INTEGER,
  build_duration_ms INTEGER,
  is_current_production INTEGER NOT NULL DEFAULT 0,
  meta            TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_state ON deployments(state);

CREATE TABLE IF NOT EXISTS build_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  level         TEXT NOT NULL DEFAULT 'info',
  text          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_deployment ON build_logs(deployment_id, seq);

CREATE TABLE IF NOT EXISTS aliases (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL UNIQUE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT REFERENCES deployments(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'deployment',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alias_project ON aliases(project_id);
CREATE INDEX IF NOT EXISTS idx_alias_deployment ON aliases(deployment_id);

CREATE TABLE IF NOT EXISTS repo_watch (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch      TEXT NOT NULL,
  last_sha    TEXT,
  checked_at  INTEGER,
  PRIMARY KEY (project_id, branch)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  event       TEXT NOT NULL,
  delivery_id TEXT,
  payload     TEXT,
  result      TEXT,
  created_at  INTEGER NOT NULL
);

-- One row per request served by the proxy. Written by the proxy process and
-- read by the API, which is why WAL mode matters. Pruned to a bounded number
-- of rows per project so this cannot grow without limit.
CREATE TABLE IF NOT EXISTS request_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  deployment_id TEXT,
  ts            INTEGER NOT NULL,
  method        TEXT NOT NULL,
  host          TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_logs_project ON request_logs(project_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_deployment ON request_logs(deployment_id, id DESC);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  project_id TEXT,
  deployment_id TEXT,
  user_id    TEXT,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
"#;

/// Additive, idempotent migrations applied after the base schema. Ran to
/// exist alongside `packages/db/src/schema.ts`'s own `MIGRATIONS` array —
/// mirror one there too only if `apps/proxy` (the one Node process left)
/// ever needs to read the same column; it doesn't for either of these, so
/// they're Rust-only.
pub const MIGRATIONS: &[&str] = &[
    // "Ignored Build Step" (see `Project::ignore_command`) — Rust-only.
    "ALTER TABLE projects ADD COLUMN ignore_command TEXT",
    // Preview comments — a lightweight, dashboard-only comment thread
    // attached to one deployment. Rust-only; apps/proxy never reads it.
    r#"CREATE TABLE IF NOT EXISTS deployment_comments (
         id            TEXT PRIMARY KEY,
         deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
         user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         body          TEXT NOT NULL,
         created_at    INTEGER NOT NULL
       )"#,
    "CREATE INDEX IF NOT EXISTS idx_comments_deployment ON deployment_comments(deployment_id, created_at ASC)",
    // Renamed the "owner" role to "admin" — same meaning (first user to ever
    // sign in), just a friendlier label. Rust-only: apps/proxy never reads
    // `role`. Idempotent — a second run finds no `owner` rows left to touch.
    "UPDATE users SET role = 'admin' WHERE role = 'owner'",
    // Optional password sign-in, as an alternative to an emailed one-time
    // code. NULL until the user sets one (at signup or later in Settings).
    // Rust-only: apps/proxy never reads `password_hash`.
    "ALTER TABLE users ADD COLUMN password_hash TEXT",
    // Ownership transfer requests — a project only actually changes hands
    // once the recipient accepts (see routes::notifications), so this holds
    // the in-between state. At most one *pending* row per project — the
    // partial unique index enforces that directly rather than relying on
    // every call site to check first. Rust-only.
    r#"CREATE TABLE IF NOT EXISTS project_transfers (
         id           TEXT PRIMARY KEY,
         project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         status       TEXT NOT NULL DEFAULT 'pending',
         created_at   INTEGER NOT NULL,
         resolved_at  INTEGER
       )"#,
    "CREATE INDEX IF NOT EXISTS idx_transfers_project ON project_transfers(project_id, created_at DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_one_pending ON project_transfers(project_id) WHERE status = 'pending'",
    // In-app notifications: ownership transfers, deployment outcomes on a
    // project you created, comments on it, and pushes that triggered a
    // build. `project_id`/`deployment_id`/`transfer_id`/`actor_id` are all
    // optional context, only as many as a given `type` needs. Rust-only.
    r#"CREATE TABLE IF NOT EXISTS notifications (
         id            TEXT PRIMARY KEY,
         user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         type          TEXT NOT NULL,
         title         TEXT NOT NULL,
         body          TEXT,
         project_id    TEXT,
         deployment_id TEXT,
         transfer_id   TEXT,
         actor_id      TEXT,
         read_at       INTEGER,
         created_at    INTEGER NOT NULL
       )"#,
    "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)",
];
