import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '@avail/shared/config';
import type {
  Alias,
  BuildLog,
  Deployment,
  DeploymentState,
  EnvTarget,
  EnvVar,
  GitIntegration,
  Project,
  Session,
  User,
} from '@avail/shared/types';
import { MIGRATIONS, SCHEMA } from './schema.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;

/** SQLite rejects `undefined` and booleans; normalize before binding. */
function normalize(params: unknown[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'number' || typeof p === 'bigint' || typeof p === 'string')
      return p;
    if (p instanceof Uint8Array) return p;
    return JSON.stringify(p);
  });
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec(SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch (err) {
      // Migrations are idempotent; duplicate-column errors are expected.
      if (!/duplicate column|already exists/i.test(String(err))) throw err;
    }
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function all<T = any>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...normalize(params)) as T[];
}

export function get<T = any>(sql: string, ...params: unknown[]): T | null {
  const row = getDb().prepare(sql).get(...normalize(params));
  return (row as T | undefined) ?? null;
}

export function run(sql: string, ...params: unknown[]) {
  return getDb().prepare(sql).run(...normalize(params));
}

/** Runs `fn` inside a transaction, rolling back on throw. */
export function transaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

const now = () => Date.now();

/* ------------------------------------------------------------------ users */

export const users = {
  byId: (id: string) => get<User>('SELECT * FROM users WHERE id = ?', id),
  byEmail: (email: string) =>
    get<User>('SELECT * FROM users WHERE email = ?', email.toLowerCase()),
  list: () => all<User>('SELECT * FROM users ORDER BY created_at ASC'),
  count: () =>
    get<{ c: number }>('SELECT COUNT(*) AS c FROM users')?.c ?? 0,
  create: (user: Omit<User, 'created_at' | 'last_login_at'>) => {
    run(
      `INSERT INTO users (id, email, name, avatar_url, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      user.id,
      user.email.toLowerCase(),
      user.name,
      user.avatar_url,
      user.role,
      now()
    );
    return users.byId(user.id)!;
  },
  touchLogin: (id: string) =>
    run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), id),
  update: (id: string, patch: Partial<Pick<User, 'name' | 'avatar_url' | 'role'>>) => {
    const fields = Object.keys(patch);
    if (!fields.length) return users.byId(id);
    run(
      `UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...fields.map((f) => (patch as any)[f]),
      id
    );
    return users.byId(id);
  },
};

/* --------------------------------------------------------------- sessions */

export const sessions = {
  create: (session: Session) => {
    run(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      session.id,
      session.user_id,
      session.created_at,
      session.expires_at,
      session.user_agent
    );
    return session;
  },
  byId: (id: string) => get<Session>('SELECT * FROM sessions WHERE id = ?', id),
  delete: (id: string) => run('DELETE FROM sessions WHERE id = ?', id),
  deleteForUser: (userId: string) =>
    run('DELETE FROM sessions WHERE user_id = ?', userId),
  purgeExpired: () => run('DELETE FROM sessions WHERE expires_at < ?', now()),
};

/* ------------------------------------------------------------ login codes */

export const loginCodes = {
  create: (row: {
    id: string;
    email: string;
    code_hash: string;
    expires_at: number;
  }) =>
    run(
      `INSERT INTO login_codes (id, email, code_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.id,
      row.email,
      row.code_hash,
      now(),
      row.expires_at
    ),
  latestForEmail: (email: string) =>
    get<{
      id: string;
      email: string;
      code_hash: string;
      expires_at: number;
      consumed_at: number | null;
      attempts: number;
    }>(
      `SELECT * FROM login_codes
       WHERE email = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      email
    ),
  consume: (id: string) =>
    run('UPDATE login_codes SET consumed_at = ? WHERE id = ?', now(), id),
  bumpAttempts: (id: string) =>
    run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', id),
  purgeExpired: () => run('DELETE FROM login_codes WHERE expires_at < ?', now()),
};

/* ------------------------------------------------------- git integrations */

export const integrations = {
  create: (row: GitIntegration) => {
    run(
      `INSERT INTO git_integrations
         (id, user_id, provider, kind, login, avatar_url, token_enc, scopes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.user_id,
      row.provider,
      row.kind,
      row.login,
      row.avatar_url,
      row.token_enc,
      row.scopes,
      row.created_at
    );
    return row;
  },
  byId: (id: string) =>
    get<GitIntegration>('SELECT * FROM git_integrations WHERE id = ?', id),
  forUser: (userId: string) =>
    all<GitIntegration>(
      'SELECT * FROM git_integrations WHERE user_id = ? ORDER BY created_at DESC',
      userId
    ),
  /** Any integration in the workspace — used for shared repo access. */
  any: () =>
    get<GitIntegration>(
      'SELECT * FROM git_integrations ORDER BY created_at DESC LIMIT 1'
    ),
  delete: (id: string) => run('DELETE FROM git_integrations WHERE id = ?', id),
};

/* --------------------------------------------------------------- projects */

export const projects = {
  byId: (id: string) => get<Project>('SELECT * FROM projects WHERE id = ?', id),
  bySlug: (slug: string) =>
    get<Project>('SELECT * FROM projects WHERE slug = ?', slug),
  byIdOrSlug: (key: string) =>
    get<Project>('SELECT * FROM projects WHERE id = ? OR slug = ?', key, key),
  byRepo: (fullName: string) =>
    all<Project>(
      'SELECT * FROM projects WHERE lower(repo_full_name) = lower(?)',
      fullName
    ),
  list: () => all<Project>('SELECT * FROM projects ORDER BY updated_at DESC'),
  withAutoDeploy: () =>
    all<Project>(
      'SELECT * FROM projects WHERE auto_deploy = 1 AND repo_full_name IS NOT NULL'
    ),
  create: (project: Project) => {
    const cols = Object.keys(project);
    run(
      `INSERT INTO projects (${cols.join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => (project as any)[c])
    );
    return projects.byId(project.id)!;
  },
  update: (id: string, patch: Partial<Project>) => {
    const fields = Object.keys(patch).filter((f) => f !== 'id');
    if (!fields.length) return projects.byId(id);
    run(
      `UPDATE projects SET ${fields
        .map((f) => `${f} = ?`)
        .join(', ')}, updated_at = ? WHERE id = ?`,
      ...fields.map((f) => (patch as any)[f]),
      now(),
      id
    );
    return projects.byId(id);
  },
  delete: (id: string) => run('DELETE FROM projects WHERE id = ?', id),
  slugTaken: (slug: string) =>
    Boolean(get('SELECT 1 AS x FROM projects WHERE slug = ?', slug)),
};

/* --------------------------------------------------------------- env vars */

export const envVars = {
  forProject: (projectId: string) =>
    all<EnvVar>(
      'SELECT * FROM env_vars WHERE project_id = ? ORDER BY key ASC',
      projectId
    ),
  byId: (id: string) => get<EnvVar>('SELECT * FROM env_vars WHERE id = ?', id),
  /** Variables that apply to a build for `target` on `branch`. */
  forBuild: (projectId: string, target: EnvTarget, branch: string | null) =>
    all<EnvVar>(
      `SELECT * FROM env_vars
       WHERE project_id = ? AND target = ?
         AND (git_branch IS NULL OR git_branch = ?)
       ORDER BY (git_branch IS NULL) DESC, key ASC`,
      projectId,
      target,
      branch
    ),
  upsert: (row: EnvVar) => {
    run(
      `INSERT INTO env_vars
         (id, project_id, key, value_enc, target, git_branch, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, key, target, IFNULL(git_branch, ''))
       DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at`,
      row.id,
      row.project_id,
      row.key,
      row.value_enc,
      row.target,
      row.git_branch,
      row.created_at,
      row.updated_at,
      row.created_by
    );
  },
  delete: (id: string) => run('DELETE FROM env_vars WHERE id = ?', id),
};

/* ------------------------------------------------------------ deployments */

export const deployments = {
  byId: (id: string) =>
    get<Deployment>('SELECT * FROM deployments WHERE id = ?', id),
  create: (deployment: Deployment) => {
    const cols = Object.keys(deployment);
    run(
      `INSERT INTO deployments (${cols.join(', ')})
       VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => (deployment as any)[c])
    );
    return deployments.byId(deployment.id)!;
  },
  update: (id: string, patch: Partial<Deployment>) => {
    const fields = Object.keys(patch).filter((f) => f !== 'id');
    if (!fields.length) return deployments.byId(id);
    run(
      `UPDATE deployments SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
      ...fields.map((f) => (patch as any)[f]),
      id
    );
    return deployments.byId(id);
  },
  setState: (id: string, state: DeploymentState, patch: Partial<Deployment> = {}) =>
    deployments.update(id, { ...patch, state }),
  forProject: (projectId: string, limit = 50, offset = 0) =>
    all<Deployment>(
      `SELECT * FROM deployments WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      projectId,
      limit,
      offset
    ),
  recent: (limit = 30) =>
    all<Deployment & { project_slug: string; project_name: string }>(
      `SELECT d.*, p.slug AS project_slug, p.name AS project_name
       FROM deployments d JOIN projects p ON p.id = d.project_id
       ORDER BY d.created_at DESC LIMIT ?`,
      limit
    ),
  queued: () =>
    all<Deployment>(
      `SELECT * FROM deployments WHERE state = 'QUEUED' ORDER BY created_at ASC`
    ),
  active: () =>
    all<Deployment>(
      `SELECT * FROM deployments
       WHERE state IN ('QUEUED', 'INITIALIZING', 'BUILDING', 'UPLOADING')
       ORDER BY created_at ASC`
    ),
  currentProduction: (projectId: string) =>
    get<Deployment>(
      `SELECT * FROM deployments
       WHERE project_id = ? AND is_current_production = 1 LIMIT 1`,
      projectId
    ),
  latestReady: (projectId: string, target?: string) =>
    get<Deployment>(
      `SELECT * FROM deployments
       WHERE project_id = ? AND state = 'READY'
         ${target ? 'AND target = ?' : ''}
       ORDER BY created_at DESC LIMIT 1`,
      ...(target ? [projectId, target] : [projectId])
    ),
  promote: (projectId: string, deploymentId: string) =>
    transaction(() => {
      run(
        'UPDATE deployments SET is_current_production = 0 WHERE project_id = ?',
        projectId
      );
      run(
        'UPDATE deployments SET is_current_production = 1 WHERE id = ?',
        deploymentId
      );
    }),
  /** Old deployments eligible for disk cleanup. */
  staleForProject: (projectId: string, keep: number) =>
    all<Deployment>(
      `SELECT * FROM deployments
       WHERE project_id = ? AND is_current_production = 0
         AND state IN ('READY', 'ERROR', 'CANCELED')
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      projectId,
      keep
    ),
  delete: (id: string) => run('DELETE FROM deployments WHERE id = ?', id),
  countForProject: (projectId: string) =>
    get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM deployments WHERE project_id = ?',
      projectId
    )?.c ?? 0,
};

/* ------------------------------------------------------------ build logs */

export const buildLogs = {
  append: (
    deploymentId: string,
    level: BuildLog['level'],
    text: string,
    seq: number
  ) => {
    run(
      `INSERT INTO build_logs (deployment_id, seq, ts, level, text)
       VALUES (?, ?, ?, ?, ?)`,
      deploymentId,
      seq,
      now(),
      level,
      text
    );
  },
  forDeployment: (deploymentId: string, sinceSeq = -1) =>
    all<BuildLog>(
      `SELECT * FROM build_logs WHERE deployment_id = ? AND seq > ?
       ORDER BY seq ASC`,
      deploymentId,
      sinceSeq
    ),
  maxSeq: (deploymentId: string) =>
    get<{ m: number | null }>(
      'SELECT MAX(seq) AS m FROM build_logs WHERE deployment_id = ?',
      deploymentId
    )?.m ?? -1,
};

/* ---------------------------------------------------------------- aliases */

export const aliases = {
  byDomain: (domain: string) =>
    get<Alias>('SELECT * FROM aliases WHERE domain = ?', domain.toLowerCase()),
  forProject: (projectId: string) =>
    all<Alias>(
      'SELECT * FROM aliases WHERE project_id = ? ORDER BY type ASC, domain ASC',
      projectId
    ),
  forDeployment: (deploymentId: string) =>
    all<Alias>('SELECT * FROM aliases WHERE deployment_id = ?', deploymentId),
  upsert: (row: Alias) => {
    run(
      `INSERT INTO aliases (id, domain, project_id, deployment_id, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         deployment_id = excluded.deployment_id,
         project_id = excluded.project_id,
         type = excluded.type,
         updated_at = excluded.updated_at`,
      row.id,
      row.domain.toLowerCase(),
      row.project_id,
      row.deployment_id,
      row.type,
      row.created_at,
      row.updated_at
    );
    return aliases.byDomain(row.domain)!;
  },
  delete: (id: string) => run('DELETE FROM aliases WHERE id = ?', id),
  list: () => all<Alias>('SELECT * FROM aliases ORDER BY domain ASC'),
};

/* ------------------------------------------------------------- repo watch */

export const repoWatch = {
  get: (projectId: string, branch: string) =>
    get<{ project_id: string; branch: string; last_sha: string | null }>(
      'SELECT * FROM repo_watch WHERE project_id = ? AND branch = ?',
      projectId,
      branch
    ),
  set: (projectId: string, branch: string, sha: string) =>
    run(
      `INSERT INTO repo_watch (project_id, branch, last_sha, checked_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, branch) DO UPDATE SET
         last_sha = excluded.last_sha, checked_at = excluded.checked_at`,
      projectId,
      branch,
      sha,
      now()
    ),
  forProject: (projectId: string) =>
    all<{ branch: string; last_sha: string | null }>(
      'SELECT branch, last_sha FROM repo_watch WHERE project_id = ?',
      projectId
    ),
};

/* ----------------------------------------------------------------- events */

export const events = {
  record: (event: {
    type: string;
    text: string;
    project_id?: string | null;
    deployment_id?: string | null;
    user_id?: string | null;
  }) =>
    run(
      `INSERT INTO events (type, project_id, deployment_id, user_id, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.type,
      event.project_id ?? null,
      event.deployment_id ?? null,
      event.user_id ?? null,
      event.text,
      now()
    ),
  recent: (limit = 50) =>
    all(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`, limit),
};

/* ----------------------------------------------------------- request logs */

export interface RequestLog {
  id: number;
  project_id: string;
  deployment_id: string | null;
  ts: number;
  method: string;
  host: string;
  path: string;
  status: number;
  duration_ms: number;
  kind: string;
  message: string | null;
}

export const requestLogs = {
  record: (row: Omit<RequestLog, 'id'>) =>
    run(
      `INSERT INTO request_logs
         (project_id, deployment_id, ts, method, host, path, status, duration_ms, kind, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.project_id,
      row.deployment_id,
      row.ts,
      row.method,
      row.host,
      row.path,
      row.status,
      row.duration_ms,
      row.kind,
      row.message
    ),

  /**
   * Newest-first page of a project's requests. `sinceId` powers live tailing:
   * the client passes the highest id it has seen and gets only what is new.
   */
  forProject: (
    projectId: string,
    options: {
      limit?: number;
      sinceId?: number;
      search?: string;
      status?: 'all' | 'error';
      deploymentId?: string | null;
    } = {}
  ) => {
    const { limit = 100, sinceId, search, status = 'all', deploymentId } = options;
    const where: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];

    if (sinceId !== undefined) {
      where.push('id > ?');
      params.push(sinceId);
    }
    if (deploymentId) {
      where.push('deployment_id = ?');
      params.push(deploymentId);
    }
    if (status === 'error') where.push('status >= 400');
    if (search) {
      where.push('(path LIKE ? OR host LIKE ? OR IFNULL(message, ' + "''" + ') LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    return all<RequestLog>(
      `SELECT * FROM request_logs WHERE ${where.join(' AND ')}
       ORDER BY id DESC LIMIT ?`,
      ...params,
      Math.min(limit, 500)
    );
  },

  /** Keeps the table bounded; called opportunistically after writes. */
  prune: (projectId: string, keep: number) =>
    run(
      `DELETE FROM request_logs
       WHERE project_id = ?
         AND id <= COALESCE(
           (SELECT id FROM request_logs WHERE project_id = ?
            ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`,
      projectId,
      projectId,
      keep
    ),

  countForProject: (projectId: string) =>
    get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM request_logs WHERE project_id = ?',
      projectId
    )?.c ?? 0,
};

export const webhookDeliveries = {
  record: (row: {
    id: string;
    project_id: string | null;
    event: string;
    delivery_id: string | null;
    payload: string | null;
    result: string;
  }) =>
    run(
      `INSERT INTO webhook_deliveries
         (id, project_id, event, delivery_id, payload, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.project_id,
      row.event,
      row.delivery_id,
      row.payload,
      row.result,
      now()
    ),
  recent: (limit = 30) =>
    all(
      'SELECT id, project_id, event, delivery_id, result, created_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?',
      limit
    ),
};
