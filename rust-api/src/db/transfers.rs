use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;
use super::types::{FromRow, ProjectTransfer};

pub fn create(conn: &Connection, id: &str, project_id: &str, from_user_id: &str, to_user_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)",
        params![id, project_id, from_user_id, to_user_id, now_ms()],
    )?;
    Ok(())
}

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<ProjectTransfer>> {
    conn.query_row("SELECT * FROM project_transfers WHERE id = ?", [id], |row| ProjectTransfer::from_row(row))
        .optional()
}

/// At most one row — the schema's partial unique index guarantees it.
pub fn pending_for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<Option<ProjectTransfer>> {
    conn.query_row(
        "SELECT * FROM project_transfers WHERE project_id = ? AND status = 'pending'",
        [project_id],
        |row| ProjectTransfer::from_row(row),
    )
    .optional()
}

/// Moves a transfer out of "pending" — `status` is one of "accepted",
/// "declined", "cancelled". Only touches rows still pending, so a stale
/// double-click (accept after it was already cancelled, say) affects zero
/// rows instead of double-resolving it.
pub fn resolve(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE project_transfers SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
        params![status, now_ms(), id],
    )
}
