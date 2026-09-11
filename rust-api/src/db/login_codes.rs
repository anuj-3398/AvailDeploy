use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;
use super::types::{FromRow, LoginCode};

pub fn create(conn: &Connection, id: &str, email: &str, code_hash: &str, expires_at: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO login_codes (id, email, code_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)",
        params![id, email, code_hash, now_ms(), expires_at],
    )?;
    Ok(())
}

pub fn latest_for_email(conn: &Connection, email: &str) -> rusqlite::Result<Option<LoginCode>> {
    conn.query_row(
        "SELECT * FROM login_codes
         WHERE email = ? AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1",
        [email],
        |row| LoginCode::from_row(row),
    )
    .optional()
}

pub fn consume(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE login_codes SET consumed_at = ? WHERE id = ?", params![now_ms(), id])?;
    Ok(())
}

pub fn bump_attempts(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?", [id])?;
    Ok(())
}

pub fn purge_expired(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM login_codes WHERE expires_at < ?", [now_ms()])?;
    Ok(())
}
