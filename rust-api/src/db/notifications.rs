use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;
use super::types::{FromRow, Notification};
use crate::ids::new_notification_id;

pub struct NewNotification<'a> {
    pub user_id: &'a str,
    pub r#type: &'a str,
    pub title: &'a str,
    pub body: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub deployment_id: Option<&'a str>,
    pub transfer_id: Option<&'a str>,
    pub actor_id: Option<&'a str>,
}

/// Every notification goes through here so callers never forget a column —
/// same shape as `events::record`, one insert, best-effort (callers use
/// `let _ =`, matching how a notification failing to save should never take
/// down the action that triggered it).
pub fn create(conn: &Connection, n: NewNotification<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO notifications
           (id, user_id, type, title, body, project_id, deployment_id, transfer_id, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            new_notification_id(),
            n.user_id,
            n.r#type,
            n.title,
            n.body,
            n.project_id,
            n.deployment_id,
            n.transfer_id,
            n.actor_id,
            now_ms(),
        ],
    )?;
    Ok(())
}

pub fn for_user(conn: &Connection, user_id: &str, limit: i64) -> rusqlite::Result<Vec<Notification>> {
    let mut stmt = conn.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")?;
    let rows = stmt.query_map(params![user_id, limit], |row| Notification::from_row(row))?;
    rows.collect()
}

pub fn unread_count(conn: &Connection, user_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL",
        [user_id],
        |row| row.get(0),
    )
}

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Notification>> {
    conn.query_row("SELECT * FROM notifications WHERE id = ?", [id], |row| Notification::from_row(row))
        .optional()
}

pub fn mark_read(conn: &Connection, id: &str, user_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
        params![now_ms(), id, user_id],
    )
}

/// Marks every notification tied to a transfer (in practice, the one
/// "someone wants to transfer X to you" request) read once that transfer is
/// resolved one way or another — so accepting, declining, or cancelling it
/// can't leave a stale Accept/Decline pair sitting in the recipient's list
/// after a refresh.
pub fn mark_read_for_transfer(conn: &Connection, transfer_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE notifications SET read_at = ? WHERE transfer_id = ? AND read_at IS NULL",
        params![now_ms(), transfer_id],
    )
}

pub fn mark_all_read(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
        params![now_ms(), user_id],
    )
}
