use rusqlite::{params, Connection, OptionalExtension};

use super::now_ms;
use super::types::{FromRow, User};

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<User>> {
    conn.query_row("SELECT * FROM users WHERE id = ?", [id], |row| User::from_row(row))
        .optional()
}

pub fn by_email(conn: &Connection, email: &str) -> rusqlite::Result<Option<User>> {
    conn.query_row(
        "SELECT * FROM users WHERE email = ?",
        [email.to_lowercase()],
        |row| User::from_row(row),
    )
    .optional()
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<User>> {
    let mut stmt = conn.prepare("SELECT * FROM users ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], |row| User::from_row(row))?;
    rows.collect()
}

pub fn count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
}

pub struct NewUser<'a> {
    pub id: &'a str,
    pub email: &'a str,
    pub name: Option<&'a str>,
    pub avatar_url: Option<&'a str>,
    pub role: &'a str,
}

/// Inserts the row and returns it back out, matching `users.create`'s
/// "trust what's now in the table" shape rather than echoing the input.
pub fn create(conn: &Connection, user: NewUser<'_>) -> rusqlite::Result<User> {
    conn.execute(
        "INSERT INTO users (id, email, name, avatar_url, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![user.id, user.email.to_lowercase(), user.name, user.avatar_url, user.role, now_ms()],
    )?;
    Ok(by_id(conn, user.id)?.expect("just inserted"))
}

pub fn touch_login(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", params![now_ms(), id])?;
    Ok(())
}

/// Sets (or clears, with `None`) the password hash — see `crypto::hash_password`.
pub fn set_password(conn: &Connection, id: &str, password_hash: Option<&str>) -> rusqlite::Result<()> {
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", params![password_hash, id])?;
    Ok(())
}

/// `name`/`avatar_url` only — the two fields `upsertUser` ever patches.
pub fn update_profile(
    conn: &Connection,
    id: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
) -> rusqlite::Result<Option<User>> {
    conn.execute(
        "UPDATE users SET name = ?, avatar_url = ? WHERE id = ?",
        params![name, avatar_url, id],
    )?;
    by_id(conn, id)
}

/// Deletes the account. `sessions` and `git_integrations` both declare
/// `ON DELETE CASCADE` on `user_id` (see schema.rs), so this alone also
/// signs out every session and disconnects every connected Git account —
/// no separate cleanup needed for either. Projects are deliberately NOT
/// cascaded (no FK on `projects.created_by`): the caller must confirm the
/// user owns none before calling this, same as a real deletion would need
/// to reassign or destroy them first.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM users WHERE id = ?", [id])?;
    Ok(())
}
