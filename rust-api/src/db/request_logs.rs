use rusqlite::{Connection, ToSql};

use super::types::{FromRow, RequestLog};

pub struct NewRequestLog<'a> {
    pub project_id: &'a str,
    pub deployment_id: Option<&'a str>,
    pub ts: i64,
    pub method: &'a str,
    pub host: &'a str,
    pub path: &'a str,
    pub status: i64,
    pub duration_ms: i64,
    pub kind: &'a str,
    pub message: Option<&'a str>,
}

pub fn record(conn: &Connection, row: NewRequestLog<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO request_logs
           (project_id, deployment_id, ts, method, host, path, status, duration_ms, kind, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            row.project_id, row.deployment_id, row.ts, row.method, row.host, row.path,
            row.status, row.duration_ms, row.kind, row.message,
        ],
    )?;
    Ok(())
}

#[derive(Default)]
pub struct ForProjectOptions<'a> {
    pub limit: i64,
    pub since_id: Option<i64>,
    pub search: Option<&'a str>,
    pub errors_only: bool,
    pub deployment_id: Option<&'a str>,
}

/// Newest-first page of a project's requests. `since_id` powers live
/// tailing: the client passes the highest id it has seen and gets only
/// what is new.
pub fn for_project(conn: &Connection, project_id: &str, opts: &ForProjectOptions<'_>) -> rusqlite::Result<Vec<RequestLog>> {
    let mut where_clauses = vec!["project_id = ?".to_string()];
    let mut params: Vec<Box<dyn ToSql>> = vec![Box::new(project_id.to_string())];

    if let Some(since_id) = opts.since_id {
        where_clauses.push("id > ?".to_string());
        params.push(Box::new(since_id));
    }
    if let Some(deployment_id) = opts.deployment_id {
        where_clauses.push("deployment_id = ?".to_string());
        params.push(Box::new(deployment_id.to_string()));
    }
    if opts.errors_only {
        where_clauses.push("status >= 400".to_string());
    }
    if let Some(search) = opts.search {
        where_clauses.push("(path LIKE ? OR host LIKE ? OR IFNULL(message, '') LIKE ?)".to_string());
        let like = format!("%{search}%");
        params.push(Box::new(like.clone()));
        params.push(Box::new(like.clone()));
        params.push(Box::new(like));
    }

    let limit = opts.limit.clamp(1, 500);
    let sql = format!(
        "SELECT * FROM request_logs WHERE {} ORDER BY id DESC LIMIT {}",
        where_clauses.join(" AND "),
        limit
    );
    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| RequestLog::from_row(row))?;
    rows.collect()
}

/// Keeps the table bounded; called opportunistically after writes.
pub fn prune(conn: &Connection, project_id: &str, keep: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM request_logs
         WHERE project_id = ?
           AND id <= COALESCE(
             (SELECT id FROM request_logs WHERE project_id = ?
              ORDER BY id DESC LIMIT 1 OFFSET ?), 0)",
        rusqlite::params![project_id, project_id, keep],
    )?;
    Ok(())
}

pub fn count_for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM request_logs WHERE project_id = ?",
        [project_id],
        |row| row.get(0),
    )
}

pub struct RecentRow {
    pub log: RequestLog,
    pub project_slug: String,
    pub project_name: String,
}

#[derive(Default)]
pub struct RecentOptions<'a> {
    pub limit: i64,
    pub since_id: Option<i64>,
    pub search: Option<&'a str>,
    pub errors_only: bool,
}

/// Newest-first page of requests across every project, joined with the
/// owning project's name/slug — the workspace-wide counterpart of
/// `for_project`.
pub fn recent(conn: &Connection, opts: &RecentOptions<'_>) -> rusqlite::Result<Vec<RecentRow>> {
    let (sql_where, params) = recent_where(opts);
    let limit = opts.limit.clamp(1, 500);
    let sql = format!(
        "SELECT r.*, p.slug AS project_slug, p.name AS project_name
         FROM request_logs r JOIN projects p ON p.id = r.project_id
         {sql_where}
         ORDER BY r.id DESC LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(RecentRow {
            log: RequestLog::from_row(row)?,
            project_slug: row.get("project_slug")?,
            project_name: row.get("project_name")?,
        })
    })?;
    rows.collect()
}

pub fn count_all(conn: &Connection, opts: &RecentOptions<'_>) -> rusqlite::Result<i64> {
    let (sql_where, params) = recent_where(opts);
    let sql = format!(
        "SELECT COUNT(*) FROM request_logs r JOIN projects p ON p.id = r.project_id {sql_where}"
    );
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.query_row(&sql, param_refs.as_slice(), |row| row.get(0))
}

fn recent_where(opts: &RecentOptions<'_>) -> (String, Vec<Box<dyn ToSql>>) {
    let mut clauses = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();

    if let Some(since_id) = opts.since_id {
        clauses.push("r.id > ?".to_string());
        params.push(Box::new(since_id));
    }
    if opts.errors_only {
        clauses.push("r.status >= 400".to_string());
    }
    if let Some(search) = opts.search {
        clauses.push("(r.path LIKE ? OR r.host LIKE ? OR IFNULL(r.message, '') LIKE ? OR p.name LIKE ?)".to_string());
        let like = format!("%{search}%");
        for _ in 0..4 {
            params.push(Box::new(like.clone()));
        }
    }

    let sql_where = if clauses.is_empty() { String::new() } else { format!("WHERE {}", clauses.join(" AND ")) };
    (sql_where, params)
}
