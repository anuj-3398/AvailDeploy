use rusqlite::{params, Connection};
use serde::Serialize;

use super::now_ms;

#[derive(Debug, Clone, Serialize)]
pub struct Event {
    pub id: i64,
    pub r#type: String,
    pub project_id: Option<String>,
    pub deployment_id: Option<String>,
    pub user_id: Option<String>,
    pub text: String,
    pub created_at: i64,
}

pub struct NewEvent<'a> {
    pub r#type: &'a str,
    pub text: &'a str,
    pub project_id: Option<&'a str>,
    pub deployment_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
}

pub fn record(conn: &Connection, event: NewEvent<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events (type, project_id, deployment_id, user_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        params![
            event.r#type, event.project_id, event.deployment_id, event.user_id, event.text, now_ms(),
        ],
    )?;
    Ok(())
}

pub fn recent(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<Event>> {
    let mut stmt = conn.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")?;
    let rows = stmt.query_map([limit], |row| {
        Ok(Event {
            id: row.get("id")?,
            r#type: row.get("type")?,
            project_id: row.get("project_id")?,
            deployment_id: row.get("deployment_id")?,
            user_id: row.get("user_id")?,
            text: row.get("text")?,
            created_at: row.get("created_at")?,
        })
    })?;
    rows.collect()
}
