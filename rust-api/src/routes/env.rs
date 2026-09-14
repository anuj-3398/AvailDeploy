//! Mirrors `apps/api/src/routes/env.ts`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::crypto::Crypto;
use crate::db::types::EnvVar;
use crate::db::{env_vars, events, now_ms};
use crate::error::{AppError, AppResult};
use crate::ids::new_env_id;
use crate::routes::projects::require_project;
use crate::state::SharedState;

const TARGETS: [&str; 3] = ["production", "preview", "development"];

fn key_valid(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub struct SetEnvVarInput {
    pub key: String,
    pub value: String,
    pub target: Option<String>,
    pub git_branch: Option<String>,
}

/// Creates or replaces one environment variable.
pub fn set_env_var(conn: &Connection, crypto: &Crypto, project_id: &str, input: &SetEnvVarInput, user_id: Option<&str>) -> AppResult<()> {
    let key = input.key.trim();
    if key.is_empty() || !key_valid(key) {
        return Err(AppError::bad_request("invalid_key", format!("\"{}\" is not a valid environment variable name", input.key)));
    }
    let target = input.target.as_deref().unwrap_or("production");
    if !TARGETS.contains(&target) {
        return Err(AppError::bad_request("invalid_target", format!("Unknown target \"{target}\"")));
    }

    let now = now_ms();
    env_vars::upsert(
        conn,
        &EnvVar {
            id: new_env_id(),
            project_id: project_id.to_string(),
            key: key.to_string(),
            value_enc: crypto.encrypt(&input.value, "env"),
            target: target.to_string(),
            git_branch: input.git_branch.as_deref().filter(|b| !b.trim().is_empty()).map(str::trim).map(str::to_string),
            created_at: now,
            updated_at: now,
            created_by: user_id.map(str::to_string),
        },
    )?;
    Ok(())
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/projects/:key/env", get(list_env).post(add_env))
        .route("/api/projects/:key/env/:id/value", get(reveal_env))
        .route("/api/projects/:key/env/:id", axum::routing::delete(delete_env))
        .route("/api/projects/:key/env/import", post(import_env))
}

fn mask_value(value: Option<&str>) -> String {
    match value {
        None => "••••••••".to_string(),
        Some(v) if v.len() <= 4 => "••••".to_string(),
        Some(v) => format!("{}{}", &v[..2], "•".repeat((v.len() - 2).min(12))),
    }
}

async fn list_env(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let rows = env_vars::for_project(&conn, &project.id)?
        .into_iter()
        .map(|row| {
            let decrypted = state.crypto.try_decrypt(&row.value_enc, "env");
            json!({
                "id": row.id,
                "key": row.key,
                "target": row.target,
                "gitBranch": row.git_branch,
                "updatedAt": row.updated_at,
                "preview": mask_value(decrypted.as_deref()),
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "env": rows })))
}

#[derive(Deserialize)]
struct OneOrManyBody {
    key: Option<String>,
    value: Option<String>,
    target: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
    variables: Option<Vec<VarEntry>>,
}

#[derive(Deserialize)]
struct VarEntry {
    key: String,
    value: String,
    target: Option<String>,
    #[serde(rename = "gitBranch")]
    git_branch: Option<String>,
}

/// Add or update variables; accepts one entry or a batch.
async fn add_env(
    user: AuthUser,
    State(state): State<SharedState>,
    Path(key): Path<String>,
    Json(body): Json<OneOrManyBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;

    let items: Vec<VarEntry> = match body.variables {
        Some(v) => v,
        None => match body.key {
            Some(k) => vec![VarEntry { key: k, value: body.value.unwrap_or_default(), target: body.target, git_branch: body.git_branch }],
            None => vec![],
        },
    };
    if items.is_empty() {
        return Err(AppError::bad_request("invalid_request", "No variables supplied"));
    }
    for item in &items {
        set_env_var(
            &conn,
            &state.crypto,
            &project.id,
            &SetEnvVarInput { key: item.key.clone(), value: item.value.clone(), target: item.target.clone(), git_branch: item.git_branch.clone() },
            Some(&user.user.id),
        )?;
    }

    events::record(
        &conn,
        events::NewEvent {
            r#type: "env.updated",
            text: &format!("Updated {} environment variable(s)", items.len()),
            project_id: Some(&project.id),
            deployment_id: None,
            user_id: Some(&user.user.id),
        },
    )?;

    Ok((StatusCode::CREATED, Json(json!({ "ok": true, "count": items.len() }))))
}

#[derive(Deserialize)]
struct EnvIdParams {
    key: String,
    id: String,
}

/// Reveals a single decrypted value. Kept as an explicit endpoint so values
/// are never included in list responses.
async fn reveal_env(_user: AuthUser, State(state): State<SharedState>, Path(params): Path<EnvIdParams>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &params.key)?;
    let row = env_vars::by_id(&conn, &params.id)?.filter(|r| r.project_id == project.id);
    let Some(row) = row else {
        return Err(AppError::not_found("Variable not found"));
    };
    Ok(Json(json!({ "key": row.key, "value": state.crypto.try_decrypt(&row.value_enc, "env").unwrap_or_default() })))
}

async fn delete_env(_user: AuthUser, State(state): State<SharedState>, Path(params): Path<EnvIdParams>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &params.key)?;
    let row = env_vars::by_id(&conn, &params.id)?.filter(|r| r.project_id == project.id);
    let Some(row) = row else {
        return Err(AppError::not_found("Variable not found"));
    };
    env_vars::delete(&conn, &row.id)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ImportBody {
    contents: Option<String>,
    target: Option<String>,
}

/// Bulk import from a `.env` style payload.
async fn import_env(user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>, Json(body): Json<ImportBody>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let contents = body.contents.unwrap_or_default();
    let target = body.target.unwrap_or_else(|| "production".to_string());
    let mut count = 0;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let key_trimmed = line[..eq].trim();
        // Strips a leading `export` + whitespace, matching /^export\s+/.
        let key_part = match key_trimmed.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start().to_string(),
            _ => key_trimmed.to_string(),
        };
        let mut value = line[eq + 1..].trim().to_string();
        let quoted = (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2);
        if quoted {
            value = value[1..value.len() - 1].to_string();
        }
        if !key_valid(&key_part) {
            continue;
        }
        set_env_var(
            &conn,
            &state.crypto,
            &project.id,
            &SetEnvVarInput { key: key_part, value, target: Some(target.clone()), git_branch: None },
            Some(&user.user.id),
        )?;
        count += 1;
    }

    Ok(Json(json!({ "ok": true, "count": count })))
}
