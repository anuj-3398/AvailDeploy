use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;
use super::types::{FromRow, Session};

pub fn create(
    conn: &Connection,
    id: &str,
    user_id: &str,
    expires_at: i64,
    user_agent: Option<&str>,
) -> rusqlite::Result<Session> {
    let created_at = now_ms();
    conn.execute(
        "INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?)",
        params![id, user_id, created_at, expires_at, user_agent],
    )?;
    Ok(Session {
        id: id.to_string(),
        user_id: user_id.to_string(),
        created_at,
        expires_at,
        user_agent: user_agent.map(str::to_string),
    })
}

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Session>> {
    conn.query_row("SELECT * FROM sessions WHERE id = ?", [id], |row| Session::from_row(row))
        .optional()
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?", [id])?;
    Ok(())
}

pub fn delete_for_user(conn: &Connection, user_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE user_id = ?", [user_id])?;
    Ok(())
}

pub fn purge_expired(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", [now_ms()])?;
    Ok(())
}
