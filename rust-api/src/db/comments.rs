//! Preview comments — a lightweight, dashboard-only comment thread attached
//! to one deployment. New in the Rust backend; there is no Node equivalent
//! and `apps/proxy` never reads this table. See `db::schema::MIGRATIONS`.

use rusqlite::{params, Connection};

use super::now_ms;
use super::types::{DeploymentComment, FromRow};

pub fn for_deployment(conn: &Connection, deployment_id: &str) -> rusqlite::Result<Vec<DeploymentComment>> {
    let mut stmt = conn.prepare("SELECT * FROM deployment_comments WHERE deployment_id = ? ORDER BY created_at ASC")?;
    let rows = stmt.query_map([deployment_id], |row| DeploymentComment::from_row(row))?;
    rows.collect()
}

pub fn create(conn: &Connection, id: &str, deployment_id: &str, user_id: &str, body: &str) -> rusqlite::Result<DeploymentComment> {
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO deployment_comments (id, deployment_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
        params![id, deployment_id, user_id, body, created_at],
    )?;
    Ok(DeploymentComment { id: id.to_string(), deployment_id: deployment_id.to_string(), user_id: user_id.to_string(), body: body.to_string(), created_at })
}

pub fn delete(conn: &Connection, id: &str, user_id: &str) -> rusqlite::Result<usize> {
    // Only the author may delete their own comment.
    conn.execute("DELETE FROM deployment_comments WHERE id = ? AND user_id = ?", params![id, user_id])
}
