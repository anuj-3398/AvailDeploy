//! Mirrors `apps/api/src/routes/git.ts`.

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::db::types::GitIntegration;
use crate::db::{integrations, users};
use crate::error::{AppError, AppResult};
use crate::github;
use crate::ids::new_integration_id;
use crate::state::SharedState;

fn serialize(row: &GitIntegration) -> Value {
    json!({
        "id": row.id, "provider": row.provider, "kind": row.kind, "login": row.login,
        "avatarUrl": row.avatar_url, "createdAt": row.created_at,
    })
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/git/integrations", get(list_integrations).post(connect_token))
        .route("/api/git/integrations/:id", axum::routing::delete(disconnect))
        .route("/api/git/repos", get(list_repos))
        .route("/api/git/repos/:owner/:repo/branches", get(branches))
}

async fn list_integrations(user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let rows = integrations::for_user(&conn, &user.user.id)?.iter().map(serialize).collect::<Vec<_>>();
    Ok(Json(json!({ "integrations": rows })))
}

#[derive(Deserialize, Default)]
struct ConnectBody {
    token: Option<String>,
}

/// Connects a GitHub personal access token — the path that works without
/// registering an OAuth app, useful for self-hosted installs.
async fn connect_token(user: AuthUser, State(state): State<SharedState>, Json(body): Json<ConnectBody>) -> AppResult<Json<Value>> {
    let token = body.token.as_deref().unwrap_or("").trim().to_string();
    if token.is_empty() {
        return Err(AppError::bad_request("invalid_token", "A GitHub token is required"));
    }

    let profile = github::user(&state.config.github.api_url, &token)
        .await
        .map_err(|_| AppError::bad_request("invalid_token", "GitHub rejected that token"))?;

    let conn = state.db.lock();
    if let Some(existing) = integrations::for_user(&conn, &user.user.id)?.into_iter().find(|i| i.login == profile.login) {
        // Re-connecting the same GitHub account to yourself (e.g. a new
        // token) replaces the old row rather than tripping the check below.
        integrations::delete(&conn, &existing.id)?;
    } else if let Some(other) = integrations::by_login(&conn, "github", &profile.login)? {
        if other.user_id != user.user.id {
            let owner = users::by_id(&conn, &other.user_id)?.map(|u| u.email).unwrap_or_else(|| "another workspace member".to_string());
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "github_already_connected",
                format!("{} is already connected to {owner}'s account", profile.login),
            ));
        }
    }

    let id = new_integration_id();
    integrations::create(
        &conn,
        integrations::NewIntegration {
            id: &id,
            user_id: &user.user.id,
            provider: "github",
            kind: "pat",
            login: &profile.login,
            avatar_url: Some(&profile.avatar_url),
            token_enc: &state.crypto.encrypt(&token, "git-token"),
            scopes: None,
            created_at: crate::db::now_ms(),
        },
    )?;
    let created = integrations::by_id(&conn, &id)?.expect("just inserted");

    Ok(Json(json!({ "integration": serialize(&created) })))
}

async fn disconnect(user: AuthUser, State(state): State<SharedState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let row = integrations::by_id(&conn, &id)?.filter(|r| r.user_id == user.user.id);
    let Some(row) = row else {
        return Err(AppError::not_found("Integration not found"));
    };
    integrations::delete(&conn, &row.id)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
struct RepoQuery {
    q: Option<String>,
    page: Option<i64>,
}

/// Repositories visible to any of the user's connected accounts.
async fn list_repos(user: AuthUser, State(state): State<SharedState>, axum::extract::Query(query): axum::extract::Query<RepoQuery>) -> AppResult<Json<Value>> {
    let rows = {
        let conn = state.db.lock();
        integrations::for_user(&conn, &user.user.id)?
    };
    if rows.is_empty() {
        return Err(AppError::bad_request("no_integration", "Connect a GitHub account first"));
    }

    let page = query.page.unwrap_or(1).max(1);
    let mut seen = HashSet::new();
    let mut repos = Vec::new();

    for row in &rows {
        let Some(token) = state.crypto.try_decrypt(&row.token_enc, "git-token") else { continue };
        let Ok(fetched) = github::repos(&state.config.github.api_url, &token, page).await else { continue };
        for repo in fetched {
            if !seen.insert(repo.full_name.clone()) {
                continue;
            }
            repos.push(json!({
                "id": repo.id.to_string(),
                "name": repo.name,
                "fullName": repo.full_name,
                "private": repo.private,
                "description": repo.description,
                "defaultBranch": repo.default_branch,
                "url": repo.html_url,
                "pushedAt": repo.pushed_at,
                "owner": repo.owner.login,
                "ownerAvatar": repo.owner.avatar_url,
                "integrationId": row.id,
                "canAdmin": repo.permissions.map(|p| p.admin).unwrap_or(false),
            }));
        }
    }

    let query_lower = query.q.as_deref().map(str::to_lowercase);
    let mut filtered: Vec<Value> = match &query_lower {
        Some(q) => repos.into_iter().filter(|r| r["fullName"].as_str().unwrap_or("").to_lowercase().contains(q.as_str())).collect(),
        None => repos,
    };
    filtered.sort_by(|a, b| b["pushedAt"].as_str().unwrap_or("").cmp(a["pushedAt"].as_str().unwrap_or("")));

    Ok(Json(json!({ "repos": filtered, "page": page })))
}

#[derive(Deserialize)]
struct BranchParams {
    owner: String,
    repo: String,
}

async fn branches(user: AuthUser, State(state): State<SharedState>, Path(params): Path<BranchParams>) -> AppResult<Json<Value>> {
    let full_name = format!("{}/{}", params.owner, params.repo);
    let rows = {
        let conn = state.db.lock();
        integrations::for_user(&conn, &user.user.id)?
    };
    for row in &rows {
        let Some(token) = state.crypto.try_decrypt(&row.token_enc, "git-token") else { continue };
        if let Ok(branches) = github::branches(&state.config.github.api_url, &token, &full_name).await {
            let list = branches.into_iter().map(|b| json!({ "name": b.name, "sha": b.commit.sha })).collect::<Vec<_>>();
            return Ok(Json(json!({ "branches": list })));
        }
    }
    Err(AppError::not_found("Repository not accessible"))
}
