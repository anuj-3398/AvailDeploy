use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;

pub struct RepoWatchRow {
    pub project_id: String,
    pub branch: String,
    pub last_sha: Option<String>,
}

pub fn get(conn: &Connection, project_id: &str, branch: &str) -> rusqlite::Result<Option<RepoWatchRow>> {
    conn.query_row(
        "SELECT project_id, branch, last_sha FROM repo_watch WHERE project_id = ? AND branch = ?",
        params![project_id, branch],
        |row| {
            Ok(RepoWatchRow {
                project_id: row.get(0)?,
                branch: row.get(1)?,
                last_sha: row.get(2)?,
            })
        },
    )
    .optional()
}

pub fn set(conn: &Connection, project_id: &str, branch: &str, sha: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO repo_watch (project_id, branch, last_sha, checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, branch) DO UPDATE SET
           last_sha = excluded.last_sha, checked_at = excluded.checked_at",
        params![project_id, branch, sha, now_ms()],
    )?;
    Ok(())
}

pub fn for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<RepoWatchRow>> {
    let mut stmt = conn.prepare("SELECT project_id, branch, last_sha FROM repo_watch WHERE project_id = ?")?;
    let rows = stmt.query_map([project_id], |row| {
        Ok(RepoWatchRow {
            project_id: row.get(0)?,
            branch: row.get(1)?,
            last_sha: row.get(2)?,
        })
    })?;
    rows.collect()
}
