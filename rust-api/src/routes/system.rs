//! Mirrors `apps/api/src/routes/system.ts`. `checkExecutor()` /
//! `queue.status` / `poller.status` need the Phase 2 worker split (see
//! `docs/rust-api-migration-plan.md`) — `/api/system/status` and
//! `/api/system/overview` return what is knowable from the database alone
//! until then, and `/api/system/poll` is a documented stub.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
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
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "avail-api", "time": crate::db::now_ms() }))
}

/// Static platform facts the dashboard needs before sign-in.
async fn info(State(state): State<SharedState>) -> Json<Value> {
    let c = &state.config;
    Json(json!({
        "name": "Avail Deploy",
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
    let conn = state.db.lock();
    let deployment_count: i64 = conn.query_row("SELECT COUNT(*) FROM deployments", [], |row| row.get(0))?;
    Ok(Json(json!({
        // Phase 2 (docs/rust-api-migration-plan.md): populated once
        // apps/worker exposes its own status the way it exposes /enqueue.
        "queue": Value::Null,
        "poller": Value::Null,
        "executor": {
            "kind": state.config.build.executor,
            "distro": state.config.build.wsl_distro,
            "ok": Value::Null,
            "detail": "not checked — Phase 2 (see docs/rust-api-migration-plan.md)",
        },
        "counts": {
            "projects": projects::list(&conn)?.len(),
            "users": users::count(&conn)?,
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

async fn poll(_user: AuthUser) -> AppError {
    AppError::new(
        StatusCode::NOT_IMPLEMENTED,
        "not_implemented",
        "Repository polling lives in apps/worker, not yet split out of the \
         Node API — see docs/rust-api-migration-plan.md (Phase 2).",
    )
}
