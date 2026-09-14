use rusqlite::{params, Connection, OptionalExtension};

use super::types::{FromRow, GitIntegration};

pub struct NewIntegration<'a> {
    pub id: &'a str,
    pub user_id: &'a str,
    pub provider: &'a str,
    pub kind: &'a str,
    pub login: &'a str,
    pub avatar_url: Option<&'a str>,
    pub token_enc: &'a str,
    pub scopes: Option<&'a str>,
    pub created_at: i64,
}

pub fn create(conn: &Connection, row: NewIntegration<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO git_integrations
           (id, user_id, provider, kind, login, avatar_url, token_enc, scopes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            row.id,
            row.user_id,
            row.provider,
            row.kind,
            row.login,
            row.avatar_url,
            row.token_enc,
            row.scopes,
            row.created_at
        ],
    )?;
    Ok(())
}

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<GitIntegration>> {
    conn.query_row("SELECT * FROM git_integrations WHERE id = ?", [id], |row| {
        GitIntegration::from_row(row)
    })
    .optional()
}

pub fn for_user(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<GitIntegration>> {
    let mut stmt = conn.prepare("SELECT * FROM git_integrations WHERE user_id = ? ORDER BY created_at DESC")?;
    let rows = stmt.query_map([user_id], |row| GitIntegration::from_row(row))?;
    rows.collect()
}

/// Whoever in the workspace (any user, not just the caller) already has this
/// exact provider account connected, if anyone — used to keep one GitHub
/// account from being connected to two different dashboard accounts at
/// once. Login comparison is case-insensitive, matching GitHub's own
/// username rules.
pub fn by_login(conn: &Connection, provider: &str, login: &str) -> rusqlite::Result<Option<GitIntegration>> {
    conn.query_row(
        "SELECT * FROM git_integrations WHERE provider = ? AND login = ? COLLATE NOCASE LIMIT 1",
        params![provider, login],
        |row| GitIntegration::from_row(row),
    )
    .optional()
}

/// Any integration in the workspace — used for shared repo access.
pub fn any(conn: &Connection) -> rusqlite::Result<Option<GitIntegration>> {
    conn.query_row(
        "SELECT * FROM git_integrations ORDER BY created_at DESC LIMIT 1",
        [],
        |row| GitIntegration::from_row(row),
    )
    .optional()
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM git_integrations WHERE id = ?", [id])?;
    Ok(())
}
