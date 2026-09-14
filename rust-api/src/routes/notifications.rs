//! In-app notifications, and the accept/decline half of an ownership
//! transfer (the request/cancel half lives in `routes::projects` — see the
//! module doc comment there). New in the Rust backend; there is no Node
//! equivalent.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::db::{events, notifications, projects, transfers};
use crate::error::{AppError, AppResult};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/notifications", get(list))
        .route("/api/notifications/read-all", post(read_all))
        .route("/api/notifications/:id/read", post(read_one))
        .route("/api/notifications/transfers/:id/accept", post(accept_transfer))
        .route("/api/notifications/transfers/:id/decline", post(decline_transfer))
}

/// `read` and "still actionable" are two different things — a notification
/// can be marked read (by "mark all read", or just opening the panel)
/// without the transfer it's about being resolved yet. `transfer_status`
/// carries the transfer's own live status so the dashboard can gate
/// Accept/Decline on *that*, not on whether the notification happens to be
/// read — see the bug this fixes in the PR/commit that added this comment.
fn serialize(n: &crate::db::types::Notification, transfer_status: Option<&str>) -> Value {
    json!({
        "id": n.id,
        "type": n.r#type,
        "title": n.title,
        "body": n.body,
        "projectId": n.project_id,
        "deploymentId": n.deployment_id,
        "transferId": n.transfer_id,
        "transferStatus": transfer_status,
        "read": n.read_at.is_some(),
        "createdAt": n.created_at,
    })
}

async fn list(user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let rows = notifications::for_user(&conn, &user.user.id, 50)?
        .iter()
        .map(|n| {
            let status = n.transfer_id.as_deref().and_then(|id| transfers::by_id(&conn, id).ok().flatten()).map(|t| t.status);
            serialize(n, status.as_deref())
        })
        .collect::<Vec<_>>();
    let unread = notifications::unread_count(&conn, &user.user.id)?;
    Ok(Json(json!({ "notifications": rows, "unreadCount": unread })))
}

async fn read_one(user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    notifications::mark_read(&conn, &id, &user.user.id)?;
    Ok(Json(json!({ "ok": true })))
}

async fn read_all(user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    notifications::mark_all_read(&conn, &user.user.id)?;
    Ok(Json(json!({ "ok": true })))
}

/// Loads the transfer and checks the caller is its recipient and it's
/// still pending — the one piece of logic `accept_transfer` and
/// `decline_transfer` share.
fn require_pending_transfer_for(conn: &rusqlite::Connection, transfer_id: &str, user_id: &str) -> AppResult<crate::db::types::ProjectTransfer> {
    let transfer = transfers::by_id(conn, transfer_id)?.ok_or_else(|| AppError::not_found("Transfer request not found"))?;
    if transfer.to_user_id != user_id {
        return Err(AppError::forbidden("This transfer wasn't sent to you"));
    }
    if transfer.status != "pending" {
        return Err(AppError::bad_request("already_resolved", "This transfer request has already been resolved"));
    }
    Ok(transfer)
}

async fn accept_transfer(user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let transfer = require_pending_transfer_for(&conn, &id, &user.user.id)?;
    let project = projects::by_id(&conn, &transfer.project_id)?.ok_or_else(|| AppError::not_found("Project not found"))?;

    if transfers::resolve(&conn, &transfer.id, "accepted")? == 0 {
        // Someone else resolved it in the moment between the check above and
        // here (e.g. the sender cancelled it) — don't apply an ownership
        // change for a transfer that's no longer actually pending.
        return Err(AppError::bad_request("already_resolved", "This transfer request has already been resolved"));
    }
    projects::update(&conn, &project.id, &[("created_by", rusqlite::types::Value::Text(user.user.id.clone()))])?;
    let _ = notifications::mark_read_for_transfer(&conn, &transfer.id);

    let _ = events::record(
        &conn,
        events::NewEvent {
            r#type: "project.transfer_accepted",
            text: &format!("{} accepted ownership of {}", user.user.email, project.name),
            project_id: Some(&project.id),
            deployment_id: None,
            user_id: Some(&user.user.id),
        },
    );
    let _ = notifications::create(
        &conn,
        notifications::NewNotification {
            user_id: &transfer.from_user_id,
            r#type: "transfer_accepted",
            title: &format!("{} accepted ownership of {}", user.user.email, project.name),
            body: None,
            project_id: Some(&project.id),
            deployment_id: None,
            transfer_id: Some(&transfer.id),
            actor_id: Some(&user.user.id),
        },
    );

    Ok(Json(json!({ "ok": true, "project": crate::routes::projects::serialize_project(&conn, &state.config, &projects::by_id(&conn, &project.id)?.expect("just updated")) })))
}

async fn decline_transfer(user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let transfer = require_pending_transfer_for(&conn, &id, &user.user.id)?;
    if transfers::resolve(&conn, &transfer.id, "declined")? == 0 {
        return Err(AppError::bad_request("already_resolved", "This transfer request has already been resolved"));
    }
    let _ = notifications::mark_read_for_transfer(&conn, &transfer.id);

    let project = projects::by_id(&conn, &transfer.project_id)?;
    let _ = notifications::create(
        &conn,
        notifications::NewNotification {
            user_id: &transfer.from_user_id,
            r#type: "transfer_declined",
            title: &format!(
                "{} declined ownership of {}",
                user.user.email,
                project.as_ref().map(|p| p.name.as_str()).unwrap_or("your project")
            ),
            body: None,
            project_id: project.as_ref().map(|p| p.id.as_str()),
            deployment_id: None,
            transfer_id: Some(&transfer.id),
            actor_id: Some(&user.user.id),
        },
    );

    Ok(Json(json!({ "ok": true })))
}
