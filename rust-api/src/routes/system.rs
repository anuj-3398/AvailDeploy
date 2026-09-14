//! Mirrors `apps/api/src/routes/system.ts`. `queue`/`poller` used to be
//! `null` here pending the Phase 2 worker split — that's done now
//! (`avail-worker`, see docs/rust-api-migration-plan.md), so `queue` is a
//! real DB-derived count and `executor` is a real live check. There is
//! still no cross-process "poller" (repository polling without webhooks)
//! in `avail-worker`, so `poller` and `/api/system/poll` remain stubs —
//! and, since that's a legitimate steady state and not just "not wired up
//! yet", the dashboard must treat every one of these fields as nullable.
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::builder;
use crate::db::{deployments, events, projects, users};
use crate::error::{AppError, AppResult};
use crate::frameworks;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/system/info", get(info))
        .route("/api/frameworks", get(frameworks_list))
        .route("/api/system/status", get(status))
        .route("/api/system/overview", get(overview))
        .route("/api/system/poll", post(poll))
        .route("/api/system/members", get(members))
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "avail-api", "time": crate::db::now_ms() }))
}

/// Static platform facts the dashboard needs before sign-in.
async fn info(State(state): State<SharedState>) -> Json<Value> {
    let c = &state.config;
    Json(json!({
        "name": "Avail Harbor",
        "allowedDomains": c.allowed_email_domains,
        "deploymentDomain": c.deployment_domain,
        "proxyPort": c.proxy_port,
        "dashboardUrl": c.dashboard_url,
        "apiUrl": c.api_url,
        "buildExecutor": c.build.executor,
        "githubOAuth": c.github.client_id.is_some(),
        "webhookUrl": format!("{}/api/webhooks/github", c.api_url),
    }))
}

async fn frameworks_list(State(state): State<SharedState>) -> Json<Value> {
    Json(json!({ "frameworks": frameworks::load(&state.config.root) }))
}

async fn status(_user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let (deployment_count, project_count, user_count, running, pending) = {
        let conn = state.db.lock();
        let deployment_count: i64 = conn.query_row("SELECT COUNT(*) FROM deployments", [], |row| row.get(0))?;
        let active = deployments::active(&conn)?;
        let running = active.iter().filter(|d| d.state != "QUEUED").count();
        let pending = active.iter().filter(|d| d.state == "QUEUED").count();
        (deployment_count, projects::list(&conn)?.len(), users::count(&conn)?, running, pending)
    };
    // No IPC into avail-worker's own semaphore, but it's a real DB-derived
    // count — not a stub — and matches `isBuilding`'s own approximation in
    // routes/deployments.rs. `concurrency` is a config fact either way.
    let (executor_ok, executor_detail) = builder::check_executor(&state.config).await;

    Ok(Json(json!({
        "queue": {
            "running": running,
            "pending": pending,
            "concurrency": state.config.build.concurrency,
        },
        // No cross-process repo-poller in avail-worker (see module doc) —
        // this really is null, not "not implemented yet".
        "poller": Value::Null,
        "executor": {
            "kind": state.config.build.executor,
            "distro": state.config.build.wsl_distro,
            "ok": executor_ok,
            "detail": executor_detail,
        },
        "counts": {
            "projects": project_count,
            "users": user_count,
            "deployments": deployment_count,
        },
    })))
}

async fn overview(_user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let all_projects = projects::list(&conn)?;
    let recent = deployments::recent(&conn, 10)?;
    let activity = events::recent(&conn, 20)?;
    Ok(Json(json!({
        "projects": all_projects.len(),
        "deployments": recent.len(),
        // Phase 2: real value once apps/worker's queue status is wired in.
        "building": Value::Null,
        "activity": activity,
    })))
}

/// Who's in this workspace and what they can do — role is workspace-wide
/// (the first person to ever sign in is `admin`, everyone else `member`),
/// not per-project, so this is the only "who owns what" list there is. Any
/// signed-in user can see it — it's just email/name/role, nothing
/// sensitive, and knowing who the admin is is the whole point.
async fn members(_user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let rows = users::list(&conn)?
        .into_iter()
        .map(|u| json!({ "id": u.id, "email": u.email, "name": u.name, "avatarUrl": u.avatar_url, "role": u.role, "createdAt": u.created_at }))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "members": rows })))
}

async fn poll(_user: AuthUser) -> AppError {
    AppError::new(
        StatusCode::NOT_IMPLEMENTED,
        "not_implemented",
        "Repository polling lives in apps/worker, not yet split out of the \
         Node API — see docs/rust-api-migration-plan.md (Phase 2).",
    )
}
