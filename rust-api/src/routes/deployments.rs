//! Mirrors `apps/api/src/routes/deployments.ts`. The two SSE endpoints poll
//! the database instead of subscribing to an in-process event bus — see
//! "Why this needs a process boundary" in docs/rust-api-migration-plan.md.
//! `cancel` on an already-running build sets a `cancelRequested` flag in the
//! deployment's `meta` JSON for apps/worker to notice, rather than aborting
//! an in-process `AbortController` it no longer has access to.

use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{Json, Router};
use axum_extra::extract::cookie::CookieJar;
use futures_util::stream::{self, Stream};
use futures_util::StreamExt;
use rusqlite::types::Value as SqlValue;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{resolve_user, AuthUser};
use crate::db::types::Deployment;
use crate::db::{build_logs, deployments, projects, request_logs};
use crate::error::{AppError, AppResult};
use crate::services::deployments::{promote_to_production, serialize_deployment};
use crate::state::SharedState;

const TERMINAL_STATES: [&str; 3] = ["READY", "ERROR", "CANCELED"];

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/deployments", get(list_recent))
        .route("/api/logs", get(all_logs))
        .route("/api/deployments/:id", get(get_deployment))
        .route("/api/deployments/:id/logs", get(build_log_history))
        .route("/api/deployments/:id/events", get(deployment_events))
        .route("/api/events", get(workspace_events))
        .route("/api/deployments/:id/cancel", axum::routing::post(cancel))
        .route("/api/deployments/:id/promote", axum::routing::post(promote))
        .route("/api/deployments/:id/redeploy", axum::routing::post(redeploy))
        .route("/api/deployments/:id", axum::routing::delete(delete_deployment))
}

fn require_deployment(conn: &rusqlite::Connection, id: &str) -> AppResult<Deployment> {
    deployments::by_id(conn, id)?.ok_or_else(|| AppError::not_found("Deployment not found"))
}

#[derive(Deserialize, Default)]
struct LimitQuery {
    limit: Option<i64>,
}

async fn list_recent(_user: AuthUser, State(state): State<SharedState>, axum::extract::Query(q): axum::extract::Query<LimitQuery>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let limit = q.limit.unwrap_or(25).clamp(1, 100);
    let rows = deployments::recent(&conn, limit)?
        .into_iter()
        .map(|row| serialize_deployment(&conn, &state.config, &row.deployment))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "deployments": rows })))
}

#[derive(Deserialize, Default)]
struct LogsQuery {
    limit: Option<i64>,
    #[serde(rename = "sinceId")]
    since_id: Option<i64>,
    q: Option<String>,
    status: Option<String>,
}

/// Requests served by the proxy across every project — the workspace-wide
/// counterpart of `/api/projects/:key/logs`.
async fn all_logs(_user: AuthUser, State(state): State<SharedState>, axum::extract::Query(q): axum::extract::Query<LogsQuery>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let opts = request_logs::RecentOptions {
        limit: q.limit.unwrap_or(100),
        since_id: q.since_id.filter(|v| *v >= 0),
        search: q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        errors_only: q.status.as_deref() == Some("error"),
    };
    let rows = request_logs::recent(&conn, &opts)?
        .into_iter()
        .map(|r| json!({
            "id": r.log.id, "ts": r.log.ts, "method": r.log.method, "host": r.log.host, "path": r.log.path,
            "status": r.log.status, "durationMs": r.log.duration_ms, "kind": r.log.kind, "message": r.log.message,
            "deploymentId": r.log.deployment_id, "projectSlug": r.project_slug, "projectName": r.project_name,
        }))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "logs": rows, "total": request_logs::count_all(&conn, &opts)? })))
}

async fn get_deployment(_user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let deployment = require_deployment(&conn, &id)?;
    let is_building = !TERMINAL_STATES.contains(&deployment.state.as_str());
    Ok(Json(json!({ "deployment": serialize_deployment(&conn, &state.config, &deployment), "isBuilding": is_building })))
}

#[derive(Deserialize, Default)]
struct SinceQuery {
    since: Option<i64>,
}

async fn build_log_history(_user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>, axum::extract::Query(q): axum::extract::Query<SinceQuery>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let deployment = require_deployment(&conn, &id)?;
    let since = q.since.unwrap_or(-1);
    let logs = build_logs::for_deployment(&conn, &deployment.id, since)?
        .into_iter()
        .map(|l| json!({ "seq": l.seq, "ts": l.ts, "level": l.level, "text": l.text }))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "state": deployment.state, "logs": logs })))
}

fn sse_event(name: &str, data: Value) -> Event {
    Event::default().event(name).data(data.to_string())
}

/// Live build output. Replays existing logs, then polls for new lines and
/// state changes until the deployment reaches a terminal state.
async fn deployment_events(
    State(state): State<SharedState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<SinceQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    // EventSource cannot set an Authorization header, so this authenticates
    // from the cookie only, same as the Node route it mirrors.
    if resolve_user(&state, &headers, &jar).is_none() {
        return Err(AppError::unauthorized("Authentication required"));
    }
    {
        let conn = state.db.lock();
        require_deployment(&conn, &id)?;
    }

    let initial_since = q.since.unwrap_or(-1);
    let deployment_id = id;

    struct StreamState {
        state: SharedState,
        deployment_id: String,
        last_seq: i64,
        last_state: Option<String>,
        done: bool,
        first_tick: bool,
    }

    let init = StreamState {
        state: state.clone(),
        deployment_id: deployment_id.clone(),
        last_seq: initial_since,
        last_state: None,
        done: false,
        first_tick: true,
    };

    let stream = stream::unfold(init, |mut s| async move {
        if s.done {
            return None;
        }
        if !s.first_tick {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        s.first_tick = false;

        let mut events = Vec::new();
        let (fresh_logs, current) = {
            let conn = s.state.db.lock();
            let fresh = build_logs::for_deployment(&conn, &s.deployment_id, s.last_seq).unwrap_or_default();
            let current = deployments::by_id(&conn, &s.deployment_id).ok().flatten();
            (fresh, current)
        };

        for line in fresh_logs {
            s.last_seq = s.last_seq.max(line.seq);
            events.push(sse_event("log", json!({ "seq": line.seq, "ts": line.ts, "level": line.level, "text": line.text })));
        }

        if let Some(current) = &current {
            if s.last_state.as_deref() != Some(current.state.as_str()) {
                s.last_state = Some(current.state.clone());
                let payload = {
                    let conn = s.state.db.lock();
                    serialize_deployment(&conn, &s.state.config, current)
                };
                events.push(sse_event("state", json!({ "state": current.state, "deployment": payload })));
                if TERMINAL_STATES.contains(&current.state.as_str()) {
                    events.push(sse_event("done", json!({ "state": current.state })));
                    s.done = true;
                }
            }
        }

        Some((events, s))
    })
    .flat_map(stream::iter)
    .map(Ok);

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("ping")))
}

/// Dashboard-wide activity stream: polls for any deployment whose state
/// changed since the last tick, across every project.
async fn workspace_events(
    State(state): State<SharedState>,
    jar: CookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    if resolve_user(&state, &headers, &jar).is_none() {
        return Err(AppError::unauthorized("Authentication required"));
    }

    struct StreamState {
        state: SharedState,
        seen: HashMap<String, String>,
        first_tick: bool,
        sent_ready: bool,
    }
    let init = StreamState { state: state.clone(), seen: HashMap::new(), first_tick: true, sent_ready: false };

    let stream = stream::unfold(init, |mut s| async move {
        if !s.sent_ready {
            s.sent_ready = true;
            return Some((vec![sse_event("ready", json!({ "ok": true }))], s));
        }
        if !s.first_tick {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        s.first_tick = false;

        let recent = {
            let conn = s.state.db.lock();
            deployments::recent(&conn, 50).unwrap_or_default()
        };

        let mut events = Vec::new();
        for row in &recent {
            let changed = s.seen.get(&row.deployment.id).map(|st| st != &row.deployment.state).unwrap_or(true);
            if changed {
                s.seen.insert(row.deployment.id.clone(), row.deployment.state.clone());
                let payload = {
                    let conn = s.state.db.lock();
                    serialize_deployment(&conn, &s.state.config, &row.deployment)
                };
                events.push(sse_event("deployment", payload));
            }
        }

        Some((events, s))
    })
    .flat_map(stream::iter)
    .map(Ok);

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)).text("ping")))
}

async fn cancel(_user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let deployment = require_deployment(&conn, &id)?;
    if TERMINAL_STATES.contains(&deployment.state.as_str()) {
        return Err(AppError::bad_request("not_cancelable", format!("Deployment is already {}", deployment.state)));
    }

    let ok = if deployment.state == "QUEUED" {
        deployments::update(
            &conn,
            &deployment.id,
            &[
                ("state", SqlValue::Text("CANCELED".to_string())),
                ("error", SqlValue::Text("Canceled before the build started".to_string())),
            ],
        )?;
        true
    } else {
        // Actively building in apps/worker — flag it for the worker's own
        // AbortController to notice rather than aborting one we don't have.
        let mut meta: serde_json::Map<String, Value> = deployment
            .meta
            .as_deref()
            .and_then(|m| serde_json::from_str(m).ok())
            .unwrap_or_default();
        meta.insert("cancelRequested".to_string(), Value::Bool(true));
        deployments::update(&conn, &deployment.id, &[("meta", SqlValue::Text(Value::Object(meta).to_string()))])?;
        true
    };

    let fresh = deployments::by_id(&conn, &deployment.id)?.expect("just updated");
    Ok(Json(json!({ "ok": ok, "deployment": serialize_deployment(&conn, &state.config, &fresh) })))
}

/// Promote a preview to production, which is also how rollback works.
async fn promote(user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let deployment = require_deployment(&conn, &id)?;
    let project = projects::by_id(&conn, &deployment.project_id)?.ok_or_else(|| AppError::not_found("Project not found"))?;
    if deployment.output_path.is_none() {
        return Err(AppError::new(
            StatusCode::GONE,
            "artifacts_pruned",
            "This deployment\u{2019}s build artifacts have been pruned. Redeploy it instead.",
        ));
    }

    let assigned = promote_to_production(&conn, &state.config, &deployment, &project, Some(&user.user.id))?;
    let fresh = deployments::by_id(&conn, &deployment.id)?.expect("just promoted");
    Ok(Json(json!({ "ok": true, "domains": assigned, "deployment": serialize_deployment(&conn, &state.config, &fresh) })))
}

#[derive(Deserialize, Default)]
struct RedeployBody {
    target: Option<String>,
}

/// Rebuild the same commit as a new deployment.
async fn redeploy(user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>, Json(body): Json<RedeployBody>) -> AppResult<(StatusCode, Json<Value>)> {
    let conn = state.db.lock();
    let source = require_deployment(&conn, &id)?;
    let project = projects::by_id(&conn, &source.project_id)?.ok_or_else(|| AppError::not_found("Project not found"))?;

    let target: &'static str = match body.target.as_deref() {
        Some("preview") => "preview",
        _ => if source.target == "production" { "production" } else { "preview" },
    };

    let deployment = crate::services::deployments::create_deployment(
        &conn,
        &state.config,
        &project,
        crate::services::deployments::CreateDeploymentInput {
            target,
            source: "redeploy",
            branch: source.branch.clone(),
            commit_sha: source.commit_sha.clone(),
            commit_message: source.commit_message.clone(),
            commit_author: source.commit_author.clone(),
            commit_url: source.commit_url.clone(),
            pr_number: source.pr_number,
            created_by: Some(user.user.id.clone()),
            meta: Some(json!({ "redeployOf": source.id })),
        },
    )?;

    Ok((StatusCode::ACCEPTED, Json(json!({ "deployment": serialize_deployment(&conn, &state.config, &deployment) }))))
}

async fn delete_deployment(_user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let deployment = require_deployment(&conn, &id)?;
    if deployment.is_current_production != 0 {
        return Err(AppError::bad_request("is_production", "Cannot delete the current production deployment"));
    }
    if deployment.state == "QUEUED" {
        deployments::update(&conn, &deployment.id, &[("state", SqlValue::Text("CANCELED".to_string()))])?;
    }
    let _ = std::fs::remove_dir_all(state.config.deployments_dir.join(&deployment.id));
    deployments::delete(&conn, &deployment.id)?;
    Ok(Json(json!({ "ok": true })))
}

