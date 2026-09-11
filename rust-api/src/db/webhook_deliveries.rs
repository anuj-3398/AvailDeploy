use rusqlite::{params, Connection};
use serde::Serialize;

use super::now_ms;

pub struct NewDelivery<'a> {
    pub id: &'a str,
    pub project_id: Option<&'a str>,
    pub event: &'a str,
    pub delivery_id: Option<&'a str>,
    pub payload: Option<&'a str>,
    pub result: &'a str,
}

pub fn record(conn: &Connection, row: NewDelivery<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO webhook_deliveries (id, project_id, event, delivery_id, payload, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![row.id, row.project_id, row.event, row.delivery_id, row.payload, row.result, now_ms()],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct DeliverySummary {
    pub id: String,
    pub project_id: Option<String>,
    pub event: String,
    pub delivery_id: Option<String>,
    pub result: Option<String>,
    pub created_at: i64,
}

pub fn recent(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<DeliverySummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, event, delivery_id, result, created_at
         FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([limit], |row| {
        Ok(DeliverySummary {
            id: row.get(0)?,
            project_id: row.get(1)?,
            event: row.get(2)?,
            delivery_id: row.get(3)?,
            result: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}
