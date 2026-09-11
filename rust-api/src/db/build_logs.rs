use rusqlite::{params, Connection};

use super::now_ms;
use super::types::{BuildLog, FromRow};

pub fn append(conn: &Connection, deployment_id: &str, level: &str, text: &str, seq: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO build_logs (deployment_id, seq, ts, level, text) VALUES (?, ?, ?, ?, ?)",
        params![deployment_id, seq, now_ms(), level, text],
    )?;
    Ok(())
}

pub fn for_deployment(conn: &Connection, deployment_id: &str, since_seq: i64) -> rusqlite::Result<Vec<BuildLog>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM build_logs WHERE deployment_id = ? AND seq > ? ORDER BY seq ASC",
    )?;
    let rows = stmt.query_map(params![deployment_id, since_seq], |row| BuildLog::from_row(row))?;
    rows.collect()
}

pub fn max_seq(conn: &Connection, deployment_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT MAX(seq) FROM build_logs WHERE deployment_id = ?",
        [deployment_id],
        |row| row.get::<_, Option<i64>>(0),
    )
    .map(|v| v.unwrap_or(-1))
}
