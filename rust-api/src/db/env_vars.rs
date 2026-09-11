use rusqlite::{params, Connection, OptionalExtension};

use super::types::{EnvVar, FromRow};

pub fn for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<EnvVar>> {
    let mut stmt = conn.prepare("SELECT * FROM env_vars WHERE project_id = ? ORDER BY key ASC")?;
    let rows = stmt.query_map([project_id], |row| EnvVar::from_row(row))?;
    rows.collect()
}

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<EnvVar>> {
    conn.query_row("SELECT * FROM env_vars WHERE id = ?", [id], |row| EnvVar::from_row(row))
        .optional()
}

/// Variables that apply to a build for `target` on `branch`.
pub fn for_build(
    conn: &Connection,
    project_id: &str,
    target: &str,
    branch: Option<&str>,
) -> rusqlite::Result<Vec<EnvVar>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM env_vars
         WHERE project_id = ? AND target = ?
           AND (git_branch IS NULL OR git_branch = ?)
         ORDER BY (git_branch IS NULL) DESC, key ASC",
    )?;
    let rows = stmt.query_map(params![project_id, target, branch], |row| EnvVar::from_row(row))?;
    rows.collect()
}

pub fn upsert(conn: &Connection, row: &EnvVar) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO env_vars
           (id, project_id, key, value_enc, target, git_branch, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, key, target, IFNULL(git_branch, ''))
         DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at",
        params![
            row.id, row.project_id, row.key, row.value_enc, row.target, row.git_branch,
            row.created_at, row.updated_at, row.created_by,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM env_vars WHERE id = ?", [id])?;
    Ok(())
}
