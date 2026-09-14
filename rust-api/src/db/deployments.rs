use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, ToSql};

use super::types::{Deployment, DeploymentWithProject, FromRow};

pub fn by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Deployment>> {
    conn.query_row("SELECT * FROM deployments WHERE id = ?", [id], |row| Deployment::from_row(row))
        .optional()
}

pub fn create(conn: &Connection, d: &Deployment) -> rusqlite::Result<Deployment> {
    conn.execute(
        "INSERT INTO deployments
           (id, project_id, state, target, source, branch, commit_sha, commit_message,
            commit_author, commit_url, pr_number, url, framework, serve_mode, start_command,
            output_path, error, created_by, created_at, building_at, ready_at,
            build_duration_ms, is_current_production, meta)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            d.id, d.project_id, d.state, d.target, d.source, d.branch, d.commit_sha,
            d.commit_message, d.commit_author, d.commit_url, d.pr_number, d.url, d.framework,
            d.serve_mode, d.start_command, d.output_path, d.error, d.created_by, d.created_at,
            d.building_at, d.ready_at, d.build_duration_ms, d.is_current_production, d.meta,
        ],
    )?;
    Ok(by_id(conn, &d.id)?.expect("just inserted"))
}

/// Only the columns present in `fields` are updated — see `projects::update`
/// for why a `Value` list is used instead of a per-field `Option`.
pub fn update(
    conn: &Connection,
    id: &str,
    fields: &[(&'static str, Value)],
) -> rusqlite::Result<Option<Deployment>> {
    if !fields.is_empty() {
        let set_clause: Vec<String> = fields.iter().map(|(col, _)| format!("{col} = ?")).collect();
        let sql = format!("UPDATE deployments SET {} WHERE id = ?", set_clause.join(", "));
        let mut params: Vec<&dyn ToSql> = fields.iter().map(|(_, v)| v as &dyn ToSql).collect();
        params.push(&id);
        conn.execute(&sql, params.as_slice())?;
    }
    by_id(conn, id)
}

pub fn set_state(
    conn: &Connection,
    id: &str,
    state: &str,
    mut extra: Vec<(&'static str, Value)>,
) -> rusqlite::Result<Option<Deployment>> {
    extra.push(("state", Value::Text(state.to_string())));
    update(conn, id, &extra)
}

pub fn for_project(
    conn: &Connection,
    project_id: &str,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<Vec<Deployment>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM deployments WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ? OFFSET ?",
    )?;
    let rows = stmt.query_map(params![project_id, limit, offset], |row| Deployment::from_row(row))?;
    rows.collect()
}

pub fn recent(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<DeploymentWithProject>> {
    let mut stmt = conn.prepare(
        "SELECT d.*, p.slug AS project_slug, p.name AS project_name
         FROM deployments d JOIN projects p ON p.id = d.project_id
         ORDER BY d.created_at DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([limit], |row| DeploymentWithProject::from_row(row))?;
    rows.collect()
}

pub fn queued(conn: &Connection) -> rusqlite::Result<Vec<Deployment>> {
    let mut stmt = conn.prepare("SELECT * FROM deployments WHERE state = 'QUEUED' ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], |row| Deployment::from_row(row))?;
    rows.collect()
}

pub fn active(conn: &Connection) -> rusqlite::Result<Vec<Deployment>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM deployments
         WHERE state IN ('QUEUED', 'INITIALIZING', 'BUILDING', 'UPLOADING')
         ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map([], |row| Deployment::from_row(row))?;
    rows.collect()
}

pub fn current_production(conn: &Connection, project_id: &str) -> rusqlite::Result<Option<Deployment>> {
    conn.query_row(
        "SELECT * FROM deployments WHERE project_id = ? AND is_current_production = 1 LIMIT 1",
        [project_id],
        |row| Deployment::from_row(row),
    )
    .optional()
}

pub fn latest_ready(
    conn: &Connection,
    project_id: &str,
    target: Option<&str>,
) -> rusqlite::Result<Option<Deployment>> {
    match target {
        Some(target) => conn
            .query_row(
                "SELECT * FROM deployments
                 WHERE project_id = ? AND state = 'READY' AND target = ?
                 ORDER BY created_at DESC LIMIT 1",
                params![project_id, target],
                |row| Deployment::from_row(row),
            )
            .optional(),
        None => conn
            .query_row(
                "SELECT * FROM deployments
                 WHERE project_id = ? AND state = 'READY'
                 ORDER BY created_at DESC LIMIT 1",
                [project_id],
                |row| Deployment::from_row(row),
            )
            .optional(),
    }
}

pub fn promote(conn: &Connection, project_id: &str, deployment_id: &str) -> rusqlite::Result<()> {
    conn.execute("BEGIN", [])?;
    let result = (|| {
        conn.execute(
            "UPDATE deployments SET is_current_production = 0 WHERE project_id = ?",
            [project_id],
        )?;
        conn.execute(
            "UPDATE deployments SET is_current_production = 1 WHERE id = ?",
            [deployment_id],
        )?;
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute("COMMIT", []).map(|_| ()),
        Err(err) => {
            let _ = conn.execute("ROLLBACK", []);
            Err(err)
        }
    }
}

/// Old deployments eligible for disk cleanup.
pub fn stale_for_project(conn: &Connection, project_id: &str, keep: i64) -> rusqlite::Result<Vec<Deployment>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM deployments
         WHERE project_id = ? AND is_current_production = 0
           AND state IN ('READY', 'ERROR', 'CANCELED')
         ORDER BY created_at DESC LIMIT -1 OFFSET ?",
    )?;
    let rows = stmt.query_map(params![project_id, keep], |row| Deployment::from_row(row))?;
    rows.collect()
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM deployments WHERE id = ?", [id])?;
    Ok(())
}

pub fn count_for_project(conn: &Connection, project_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM deployments WHERE project_id = ?",
        [project_id],
        |row| row.get(0),
    )
}
