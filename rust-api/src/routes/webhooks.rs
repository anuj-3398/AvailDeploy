//! Mirrors `apps/api/src/routes/webhooks.ts`.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::crypto::verify_github_signature;
use crate::db::types::Project;
use crate::db::{projects, repo_watch, webhook_deliveries};
use crate::error::AppError;
use crate::ids::id;
use crate::logger;
use crate::services::deployments::create_deployment;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/webhooks/github", axum::routing::post(github_webhook))
        .route("/api/webhooks/deliveries", get(deliveries))
}

/// Projects connected to `full_name` whose signature matches the payload.
fn matching_projects(state: &SharedState, conn: &rusqlite::Connection, full_name: &str, raw: &[u8], signature: Option<&str>) -> Vec<Project> {
    let candidates = projects::by_repo(conn, full_name).unwrap_or_default();
    candidates
        .into_iter()
        .filter(|project| {
            let secret = project.webhook_secret.as_deref().or(state.config.github.webhook_secret.as_deref());
            match secret {
                // Without a configured secret we accept the delivery but the
                // caller is expected to know that is unsigned.
                None => true,
                Some(secret) => verify_github_signature(raw, signature, secret),
            }
        })
        .collect()
}

async fn github_webhook(State(state): State<SharedState>, headers: HeaderMap, raw: Bytes) -> Result<Response, AppError> {
    let log = logger::scoped("webhook");
    let event = headers.get("x-github-event").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let delivery = headers.get("x-github-delivery").and_then(|v| v.to_str().ok()).map(str::to_string);
    let signature = headers.get("x-hub-signature-256").and_then(|v| v.to_str().ok());

    let payload: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);

    if event == "ping" {
        return Ok(Json(json!({ "ok": true, "pong": true })).into_response());
    }

    let Some(full_name) = payload.get("repository").and_then(|r| r.get("full_name")).and_then(|f| f.as_str()) else {
        return Err(AppError::bad_request("invalid_payload", "Unsupported webhook payload"));
    };

    let conn = state.db.lock();
    let matched = matching_projects(&state, &conn, full_name, &raw, signature);
    if matched.is_empty() {
        let known = !projects::by_repo(&conn, full_name).unwrap_or_default().is_empty();
        let result = if known { "signature_mismatch" } else { "no_project_connected" };
        webhook_deliveries::record(
            &conn,
            webhook_deliveries::NewDelivery { id: &id("whk", 20), project_id: None, event: &event, delivery_id: delivery.as_deref(), payload: None, result },
        )?;
        log.warn(format!("Ignored {event} for {full_name}: {result}"));
        let status = if known { StatusCode::UNAUTHORIZED } else { StatusCode::ACCEPTED };
        return Ok((status, Json(json!({ "ok": false, "reason": result }))).into_response());
    }

    let mut created: Vec<String> = Vec::new();
    for project in &matched {
        let result = match event.as_str() {
            "push" => handle_push(&conn, &state, project, &payload),
            "pull_request" => handle_pull_request(&conn, &state, project, &payload),
            _ => Ok(Vec::new()),
        };
        match result {
            Ok(ids) => {
                let deployed = !ids.is_empty();
                created.extend(ids);
                let result = if deployed { "deployed" } else { "ignored" };
                let _ = webhook_deliveries::record(
                    &conn,
                    webhook_deliveries::NewDelivery { id: &id("whk", 20), project_id: Some(&project.id), event: &event, delivery_id: delivery.as_deref(), payload: None, result },
                );
            }
            Err(err) => {
                log.error(format!("Webhook handling failed for {}: {}", project.slug, err.message));
                let result_text = format!("error: {}", err.message);
                let _ = webhook_deliveries::record(
                    &conn,
                    webhook_deliveries::NewDelivery { id: &id("whk", 20), project_id: Some(&project.id), event: &event, delivery_id: delivery.as_deref(), payload: None, result: &result_text },
                );
            }
        }
    }

    Ok(Json(json!({ "ok": true, "event": event, "deployments": created })).into_response())
}

fn handle_push(conn: &rusqlite::Connection, state: &SharedState, project: &Project, payload: &Value) -> Result<Vec<String>, AppError> {
    if project.auto_deploy == 0 {
        return Ok(Vec::new());
    }
    if payload.get("deleted").and_then(|d| d.as_bool()).unwrap_or(false) {
        return Ok(Vec::new());
    }
    let Some(git_ref) = payload.get("ref").and_then(|r| r.as_str()) else { return Ok(Vec::new()) };
    let Some(branch) = git_ref.strip_prefix("refs/heads/") else { return Ok(Vec::new()) };

    let is_production = branch == project.production_branch;
    if !is_production && project.preview_deploys == 0 {
        return Ok(Vec::new());
    }

    let commit = payload.get("head_commit").filter(|c| !c.is_null());
    let sha = commit
        .and_then(|c| c.get("id"))
        .and_then(|s| s.as_str())
        .or_else(|| payload.get("after").and_then(|a| a.as_str()))
        .map(str::to_string);
    if let Some(sha) = &sha {
        let _ = repo_watch::set(conn, &project.id, branch, sha);
    }

    let commit_message = commit.and_then(|c| c.get("message")).and_then(|m| m.as_str()).map(|m| m.split('\n').next().unwrap_or(m).to_string());
    let commit_author = commit
        .map(|c| {
            let author = c.get("author");
            let name = author.and_then(|a| a.get("name")).and_then(|n| n.as_str()).unwrap_or("");
            let email = author.and_then(|a| a.get("email")).and_then(|n| n.as_str()).unwrap_or("");
            format!("{name} <{email}>")
        })
        .or_else(|| payload.get("pusher").and_then(|p| p.get("name")).and_then(|n| n.as_str()).map(str::to_string));
    let commit_url = commit.and_then(|c| c.get("url")).and_then(|u| u.as_str()).map(str::to_string);

    let deployment = create_deployment(
        conn,
        &state.config,
        project,
        crate::services::deployments::CreateDeploymentInput {
            target: if is_production { "production" } else { "preview" },
            source: "git",
            branch: Some(branch.to_string()),
            commit_sha: sha,
            commit_message,
            commit_author,
            commit_url,
            meta: Some(json!({ "trigger": "webhook:push" })),
            ..Default::default()
        },
    )?;

    logger::scoped("webhook").info(format!(
        "Push to {}@{branch} -> {} ({})",
        project.repo_full_name.as_deref().unwrap_or(""),
        deployment.id,
        deployment.target
    ));
    Ok(vec![deployment.id])
}

const PR_ACTIONS: [&str; 4] = ["opened", "synchronize", "reopened", "ready_for_review"];

fn handle_pull_request(conn: &rusqlite::Connection, state: &SharedState, project: &Project, payload: &Value) -> Result<Vec<String>, AppError> {
    if project.auto_deploy == 0 || project.preview_deploys == 0 {
        return Ok(Vec::new());
    }
    let action = payload.get("action").and_then(|a| a.as_str()).unwrap_or("");
    if !PR_ACTIONS.contains(&action) {
        return Ok(Vec::new());
    }
    let Some(pr) = payload.get("pull_request") else { return Ok(Vec::new()) };
    let draft = pr.get("draft").and_then(|d| d.as_bool()).unwrap_or(false);
    if draft && action != "ready_for_review" {
        return Ok(Vec::new());
    }

    let number = pr.get("number").and_then(|n| n.as_i64());
    let head_ref = pr.get("head").and_then(|h| h.get("ref")).and_then(|r| r.as_str()).unwrap_or("").to_string();
    let head_sha = pr.get("head").and_then(|h| h.get("sha")).and_then(|s| s.as_str()).unwrap_or("").to_string();
    let title = pr.get("title").and_then(|t| t.as_str()).map(str::to_string);
    let author = pr.get("user").and_then(|u| u.get("login")).and_then(|l| l.as_str()).map(str::to_string);
    let html_url = pr.get("html_url").and_then(|u| u.as_str()).map(str::to_string);

    let deployment = create_deployment(
        conn,
        &state.config,
        project,
        crate::services::deployments::CreateDeploymentInput {
            target: "preview",
            source: "git",
            branch: Some(head_ref.clone()),
            commit_sha: Some(head_sha.clone()),
            commit_message: title,
            commit_author: author,
            commit_url: html_url,
            pr_number: number,
            meta: Some(json!({ "trigger": format!("webhook:pull_request:{action}") })),
            ..Default::default()
        },
    )?;

    let _ = repo_watch::set(conn, &project.id, &head_ref, &head_sha);
    logger::scoped("webhook").info(format!(
        "PR #{} on {} -> preview {}",
        number.unwrap_or(0),
        project.repo_full_name.as_deref().unwrap_or(""),
        deployment.id
    ));
    Ok(vec![deployment.id])
}

/// Webhook delivery history, for debugging integrations.
async fn deliveries(State(state): State<SharedState>) -> Result<Json<Value>, AppError> {
    let conn = state.db.lock();
    let rows = webhook_deliveries::recent(&conn, 50)?;
    Ok(Json(json!({ "deliveries": rows })))
}
