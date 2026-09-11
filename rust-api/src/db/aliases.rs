use rusqlite::{params, Connection, OptionalExtension};

use super::types::{Alias, FromRow};

pub fn by_domain(conn: &Connection, domain: &str) -> rusqlite::Result<Option<Alias>> {
    conn.query_row(
        "SELECT * FROM aliases WHERE domain = ?",
        [domain.to_lowercase()],
        |row| Alias::from_row(row),
    )
    .optional()
}

pub fn for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<Vec<Alias>> {
    let mut stmt = conn.prepare("SELECT * FROM aliases WHERE project_id = ? ORDER BY type ASC, domain ASC")?;
    let rows = stmt.query_map([project_id], |row| Alias::from_row(row))?;
    rows.collect()
}

pub fn for_deployment(conn: &Connection, deployment_id: &str) -> rusqlite::Result<Vec<Alias>> {
    let mut stmt = conn.prepare("SELECT * FROM aliases WHERE deployment_id = ?")?;
    let rows = stmt.query_map([deployment_id], |row| Alias::from_row(row))?;
    rows.collect()
}

pub fn upsert(conn: &Connection, row: &Alias) -> rusqlite::Result<Alias> {
    let domain = row.domain.to_lowercase();
    conn.execute(
        "INSERT INTO aliases (id, domain, project_id, deployment_id, type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           deployment_id = excluded.deployment_id,
           project_id = excluded.project_id,
           type = excluded.type,
           updated_at = excluded.updated_at",
        params![
            row.id, domain, row.project_id, row.deployment_id, row.r#type, row.created_at, row.updated_at,
        ],
    )?;
    Ok(by_domain(conn, &domain)?.expect("just upserted"))
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM aliases WHERE id = ?", [id])?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Alias>> {
    let mut stmt = conn.prepare("SELECT * FROM aliases ORDER BY domain ASC")?;
    let rows = stmt.query_map([], |row| Alias::from_row(row))?;
    rows.collect()
}
