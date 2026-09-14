use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, ToSql};

use super::now_ms;
use super::types::{FromRow, Project};

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Project>> {
    conn.query_row("SELECT * FROM projects WHERE id = ?", [id], |row| Project::from_row(row))
        .optional()
}

pub fn by_slug(conn: &Connection, slug: &str) -> rusqlite::Result<Option<Project>> {
    conn.query_row("SELECT * FROM projects WHERE slug = ?", [slug], |row| Project::from_row(row))
        .optional()
}

/// `key` may be an id or a slug — every route handler accepts either in the
/// `:key` path segment, matching `requireProject` in the Node routes.
pub fn by_id_or_slug(conn: &Connection, key: &str) -> rusqlite::Result<Option<Project>> {
    conn.query_row(
        "SELECT * FROM projects WHERE id = ? OR slug = ?",
        [key, key],
        |row| Project::from_row(row),
    )
    .optional()
}

pub fn by_repo(conn: &Connection, full_name: &str) -> rusqlite::Result<Vec<Project>> {
    let mut stmt = conn.prepare("SELECT * FROM projects WHERE lower(repo_full_name) = lower(?)")?;
    let rows = stmt.query_map([full_name], |row| Project::from_row(row))?;
    rows.collect()
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let mut stmt = conn.prepare("SELECT * FROM projects ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |row| Project::from_row(row))?;
    rows.collect()
}

/// Every project this user created — used to block account deletion until
/// they're all gone (see `routes::auth::delete_account`).
pub fn by_creator(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Project>> {
    let mut stmt = conn.prepare("SELECT * FROM projects WHERE created_by = ? ORDER BY created_at ASC")?;
    let rows = stmt.query_map([user_id], |row| Project::from_row(row))?;
    rows.collect()
}

pub fn with_auto_deploy(conn: &Connection) -> rusqlite::Result<Vec<Project>> {
    let mut stmt =
        conn.prepare("SELECT * FROM projects WHERE auto_deploy = 1 AND repo_full_name IS NOT NULL")?;
    let rows = stmt.query_map([], |row| Project::from_row(row))?;
    rows.collect()
}

pub fn create(conn: &Connection, p: &Project) -> rusqlite::Result<Project> {
    conn.execute(
        "INSERT INTO projects
           (id, name, slug, framework, root_directory, install_command, build_command,
            output_directory, dev_command, node_version, serve_mode, repo_provider,
            repo_full_name, repo_id, repo_default_branch, production_branch, auto_deploy,
            preview_deploys, git_integration_id, webhook_secret, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            p.id, p.name, p.slug, p.framework, p.root_directory, p.install_command,
            p.build_command, p.output_directory, p.dev_command, p.node_version, p.serve_mode,
            p.repo_provider, p.repo_full_name, p.repo_id, p.repo_default_branch,
            p.production_branch, p.auto_deploy, p.preview_deploys, p.git_integration_id,
            p.webhook_secret, p.created_by, p.created_at, p.updated_at,
        ],
    )?;
    Ok(by_id(conn, &p.id)?.expect("just inserted"))
}

/// Only the columns present in `fields` are updated, exactly like
/// `projects.update`'s partial-object patch — `updated_at` is always bumped.
/// Column names are never user input (call sites pass `&'static str`s), so
/// building the `SET` clause by string concatenation is safe here.
pub fn update(
    conn: &Connection,
    id: &str,
    fields: &[(&'static str, Value)],
) -> rusqlite::Result<Option<Project>> {
    if !fields.is_empty() {
        let set_clause: Vec<String> = fields.iter().map(|(col, _)| format!("{col} = ?")).collect();
        let sql = format!(
            "UPDATE projects SET {}, updated_at = ? WHERE id = ?",
            set_clause.join(", ")
        );
        let mut params: Vec<&dyn ToSql> = fields.iter().map(|(_, v)| v as &dyn ToSql).collect();
        let updated_at = now_ms();
        params.push(&updated_at);
        params.push(&id);
        conn.execute(&sql, params.as_slice())?;
    }
    by_id(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?", [id])?;
    Ok(())
}

pub fn slug_taken(conn: &Connection, slug: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM projects WHERE slug = ?", [slug], |_| Ok(()))
        .optional()
        .map(|r| r.is_some())
}
