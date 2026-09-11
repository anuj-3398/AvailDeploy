//! Mirrors `apps/api/src/routes/projects.ts`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::auth::AuthUser;
use crate::config::Config;
use crate::crypto::random_secret;
use crate::db::types::Project;
use crate::db::{aliases, deployments, events, now_ms, projects, request_logs};
use crate::error::{AppError, AppResult};
use crate::github;
use crate::ids::{new_alias_id, new_project_id, slugify};
use crate::routes::env::{set_env_var, SetEnvVarInput};
use crate::services::deployments::{
    create_deployment, git_token_for, serialize_deployment, url_for, CreateDeploymentInput,
};
use crate::state::SharedState;

pub fn serialize_project(conn: &Connection, cfg: &Config, project: &Project) -> Value {
    let production = deployments::current_production(conn, &project.id).ok().flatten();
    let latest = deployments::for_project(conn, &project.id, 1, 0).ok().and_then(|mut v| v.pop());
    let repo = project.repo_full_name.as_ref().map(|full_name| {
        let url = if project.repo_provider.as_deref() == Some("github") {
            format!("https://github.com/{full_name}")
        } else {
            full_name.clone()
        };
        json!({
            "provider": project.repo_provider,
            "fullName": full_name,
            "defaultBranch": project.repo_default_branch,
            "url": url,
        })
    });

    json!({
        "id": project.id,
        "name": project.name,
        "slug": project.slug,
        "framework": project.framework,
        "rootDirectory": project.root_directory,
        "installCommand": project.install_command,
        "buildCommand": project.build_command,
        "outputDirectory": project.output_directory,
        "devCommand": project.dev_command,
        "nodeVersion": project.node_version,
        "serveMode": project.serve_mode,
        "repo": repo,
        "productionBranch": project.production_branch,
        "autoDeploy": project.auto_deploy != 0,
        "previewDeploys": project.preview_deploys != 0,
        "productionUrl": url_for(cfg, &format!("{}.{}", project.slug, cfg.deployment_domain)),
        "createdAt": project.created_at,
        "updatedAt": project.updated_at,
        "productionDeployment": production.as_ref().map(|d| serialize_deployment(conn, cfg, d)),
        "latestDeployment": latest.as_ref().map(|d| serialize_deployment(conn, cfg, d)),
        "deploymentCount": deployments::count_for_project(conn, &project.id).unwrap_or(0),
    })
}

/// Resolves `:key` (id or slug) or a 404.
pub fn require_project(conn: &Connection, key: &str) -> AppResult<Project> {
    projects::by_id_or_slug(conn, key)?.ok_or_else(|| AppError::not_found("Project not found"))
}

fn unique_slug(conn: &Connection, name: &str) -> AppResult<String> {
    let base = slugify(name);
    if !projects::slug_taken(conn, &base)? {
        return Ok(base);
    }
    for i in 2..1000 {
        let candidate = format!("{base}-{i}");
        if !projects::slug_taken(conn, &candidate)? {
            return Ok(candidate);
        }
    }
    Err(AppError::new(StatusCode::CONFLICT, "slug_conflict", "Could not allocate a project name"))
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/api/projects", get(list_projects).post(create_project))
        .route("/api/projects/:key", get(get_project).patch(patch_project).delete(delete_project))
        .route("/api/projects/:key/deploy", post(trigger_deploy))
        .route("/api/projects/:key/deployments", get(list_deployments))
        .route("/api/projects/:key/logs", get(project_logs))
        .route("/api/projects/:key/webhook", get(webhook_info).post(register_webhook))
        .route("/api/projects/:key/domains", get(list_domains).post(add_domain))
        .route("/api/projects/:key/domains/:domain", axum::routing::delete(delete_domain))
}

async fn list_projects(_user: AuthUser, State(state): State<SharedState>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let rows = projects::list(&conn)?.iter().map(|p| serialize_project(&conn, &state.config, p)).collect::<Vec<_>>();
    Ok(Json(json!({ "projects": rows })))
}

#[derive(Deserialize, Default)]
struct EnvItem {
    key: String,
    value: String,
    target: Option<String>,
}

#[derive(Deserialize, Default)]
struct CreateProjectBody {
    name: Option<String>,
    #[serde(rename = "repoFullName")]
    repo_full_name: Option<String>,
    #[serde(rename = "repoUrl")]
    repo_url: Option<String>,
    #[serde(rename = "integrationId")]
    integration_id: Option<String>,
    framework: Option<String>,
    #[serde(rename = "rootDirectory")]
    root_directory: Option<String>,
    #[serde(rename = "installCommand")]
    install_command: Option<String>,
    #[serde(rename = "buildCommand")]
    build_command: Option<String>,
    #[serde(rename = "outputDirectory")]
    output_directory: Option<String>,
    #[serde(rename = "devCommand")]
    dev_command: Option<String>,
    #[serde(rename = "serveMode")]
    serve_mode: Option<String>,
    #[serde(rename = "nodeVersion")]
    node_version: Option<String>,
    #[serde(rename = "productionBranch")]
    production_branch: Option<String>,
    #[serde(rename = "autoDeploy")]
    auto_deploy: Option<bool>,
    #[serde(rename = "previewDeploys")]
    preview_deploys: Option<bool>,
    env: Option<Vec<EnvItem>>,
    deploy: Option<bool>,
}

/// Imports a repository as a project. `repoFullName` uses a connected
/// GitHub account; `repoUrl` accepts any git URL or local path.
// `repo_provider`/`repo_full_name`/`default_branch` start `None` and both
// branches below always overwrite it — mirrors the `let x = null; if
// (...) { x = ... } else { x = ... }` shape of the Node original more
// directly than restructuring into a match expression would.
#[allow(unused_assignments)]
async fn create_project(
    user: AuthUser,
    State(state): State<SharedState>,
    Json(body): Json<CreateProjectBody>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let mut repo_provider: Option<String> = None;
    let mut repo_full_name: Option<String> = None;
    let mut repo_id: Option<String> = None;
    let mut default_branch: Option<String> = None;
    let mut integration_id: Option<String> = None;

    if let Some(wanted) = &body.repo_full_name {
        let candidates = {
            let conn = state.db.lock();
            match &body.integration_id {
                Some(id) => crate::db::integrations::by_id(&conn, id)?.into_iter().collect::<Vec<_>>(),
                None => crate::db::integrations::for_user(&conn, &user.user.id)?,
            }
        };
        if candidates.is_empty() {
            return Err(AppError::bad_request("no_integration", "Connect a GitHub account first"));
        }

        let mut resolved = None;
        for row in &candidates {
            let Some(token) = state.crypto.try_decrypt(&row.token_enc, "git-token") else { continue };
            if let Ok(repo) = github::repo(&state.config.github.api_url, &token, wanted).await {
                resolved = Some((repo, row.clone()));
                break;
            }
        }
        let Some((repo, integration)) = resolved else {
            return Err(AppError::not_found(format!("Repository {wanted} is not accessible with your connected accounts")));
        };
        repo_provider = Some("github".to_string());
        repo_full_name = Some(repo.full_name);
        repo_id = Some(repo.id.to_string());
        default_branch = Some(repo.default_branch);
        integration_id = Some(integration.id);
    } else if let Some(repo_url) = &body.repo_url {
        let is_github = repo_url.starts_with("https://github.com/") || repo_url.starts_with("http://github.com/") || repo_url.starts_with("https://www.github.com/") || repo_url.starts_with("http://www.github.com/");
        repo_provider = Some(if is_github { "github".to_string() } else { "local".to_string() });
        repo_full_name = Some(if is_github {
            repo_url
                .replacen("https://www.github.com/", "", 1)
                .replacen("http://www.github.com/", "", 1)
                .replacen("https://github.com/", "", 1)
                .replacen("http://github.com/", "", 1)
                .trim_end_matches(".git")
                .to_string()
        } else {
            repo_url.clone()
        });
        default_branch = Some(body.production_branch.clone().unwrap_or_else(|| "main".to_string()));
    } else {
        return Err(AppError::bad_request("missing_repo", "Provide either repoFullName (connected GitHub repo) or repoUrl"));
    }

    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| repo_full_name.as_ref().and_then(|f| f.rsplit('/').next()).map(str::to_string))
        .unwrap_or_else(|| "project".to_string());

    let now = now_ms();
    let conn = state.db.lock();
    let slug = unique_slug(&conn, &name)?;
    let project = projects::create(
        &conn,
        &Project {
            id: new_project_id(),
            name: name.clone(),
            slug,
            framework: body.framework.clone(),
            root_directory: body.root_directory.clone(),
            install_command: body.install_command.clone(),
            build_command: body.build_command.clone(),
            output_directory: body.output_directory.clone(),
            dev_command: body.dev_command.clone(),
            node_version: body.node_version.clone().unwrap_or_else(|| state.config.build.default_node_version.clone()),
            serve_mode: body.serve_mode.clone(),
            repo_provider,
            repo_full_name: repo_full_name.clone(),
            repo_id,
            repo_default_branch: default_branch.clone(),
            production_branch: body.production_branch.clone().or_else(|| default_branch.clone()).unwrap_or_else(|| "main".to_string()),
            auto_deploy: if body.auto_deploy == Some(false) { 0 } else { 1 },
            preview_deploys: if body.preview_deploys == Some(false) { 0 } else { 1 },
            git_integration_id: integration_id,
            webhook_secret: Some(random_secret(24)),
            created_by: user.user.id.clone(),
            created_at: now,
            updated_at: now,
        },
    )?;

    if let Some(items) = &body.env {
        for item in items {
            set_env_var(
                &conn,
                &state.crypto,
                &project.id,
                &SetEnvVarInput { key: item.key.clone(), value: item.value.clone(), target: item.target.clone(), git_branch: None },
                Some(&user.user.id),
            )?;
        }
    }

    events::record(
        &conn,
        events::NewEvent {
            r#type: "project.created",
            text: &format!("Imported {}", repo_full_name.as_deref().unwrap_or("")),
            project_id: Some(&project.id),
            deployment_id: None,
            user_id: Some(&user.user.id),
        },
    )?;

    // Node's poller seeds branch heads here so the first poll does not
    // deploy every branch at once — that lives in apps/worker now, which
    // seeds on its own next tick since this project has no repo_watch rows
    // yet (see docs/rust-api-migration-plan.md).

    let deployment = if body.deploy != Some(false) {
        Some(create_deployment(
            &conn,
            &state.config,
            &project,
            CreateDeploymentInput {
                target: "production",
                source: "manual",
                branch: Some(project.production_branch.clone()),
                created_by: Some(user.user.id.clone()),
                meta: Some(json!({ "trigger": "import" })),
                ..Default::default()
            },
        )?)
    } else {
        None
    };

    let fresh = projects::by_id(&conn, &project.id)?.expect("just created");
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "project": serialize_project(&conn, &state.config, &fresh),
            "deployment": deployment.as_ref().map(|d| serialize_deployment(&conn, &state.config, d)),
        })),
    ))
}

async fn get_project(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    Ok(Json(json!({ "project": serialize_project(&conn, &state.config, &project) })))
}

const PATCH_FIELD_MAP: &[(&str, &str)] = &[
    ("name", "name"),
    ("framework", "framework"),
    ("rootDirectory", "root_directory"),
    ("installCommand", "install_command"),
    ("buildCommand", "build_command"),
    ("outputDirectory", "output_directory"),
    ("devCommand", "dev_command"),
    ("nodeVersion", "node_version"),
    ("serveMode", "serve_mode"),
    ("productionBranch", "production_branch"),
];

async fn patch_project(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>, Json(body): Json<Map<String, Value>>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;

    let mut fields: Vec<(&'static str, SqlValue)> = Vec::new();
    for (api_key, column) in PATCH_FIELD_MAP {
        if let Some(value) = body.get(*api_key) {
            let sql_value = match value {
                Value::Null => SqlValue::Null,
                Value::String(s) if s.is_empty() => SqlValue::Null,
                Value::String(s) => SqlValue::Text(s.clone()),
                other => SqlValue::Text(other.to_string()),
            };
            fields.push((column, sql_value));
        }
    }
    if let Some(v) = body.get("autoDeploy") {
        fields.push(("auto_deploy", SqlValue::Integer(if v.as_bool().unwrap_or(false) { 1 } else { 0 })));
    }
    if let Some(v) = body.get("previewDeploys") {
        fields.push(("preview_deploys", SqlValue::Integer(if v.as_bool().unwrap_or(false) { 1 } else { 0 })));
    }

    projects::update(&conn, &project.id, &fields)?;
    let fresh = projects::by_id(&conn, &project.id)?.expect("just updated");
    Ok(Json(json!({ "project": serialize_project(&conn, &state.config, &fresh) })))
}

async fn delete_project(user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    for deployment in deployments::for_project(&conn, &project.id, 1000, 0)? {
        let _ = std::fs::remove_dir_all(state.config.deployments_dir.join(&deployment.id));
    }
    projects::delete(&conn, &project.id)?;
    events::record(
        &conn,
        events::NewEvent {
            r#type: "project.deleted",
            text: &format!("Deleted project {}", project.name),
            project_id: None,
            deployment_id: None,
            user_id: Some(&user.user.id),
        },
    )?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize, Default)]
struct DeployBody {
    branch: Option<String>,
    target: Option<String>,
    sha: Option<String>,
}

/// Manually trigger a deployment (the dashboard's Redeploy / Deploy button).
#[axum::debug_handler]
async fn trigger_deploy(user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>, Json(body): Json<DeployBody>) -> AppResult<(StatusCode, Json<Value>)> {
    // The DB mutex must not be held across an `.await` (it would block every
    // other request on this process for as long as the GitHub call takes),
    // so the lock is dropped before the network round trip and re-acquired
    // after.
    let (project, branch, target, token_and_repo) = {
        let conn = state.db.lock();
        let project = require_project(&conn, &key)?;
        let branch = body.branch.filter(|b| !b.is_empty()).unwrap_or_else(|| project.production_branch.clone());
        let target: &'static str = match body.target.as_deref() {
            Some("preview") => "preview",
            Some("production") => "production",
            _ => if branch == project.production_branch { "production" } else { "preview" },
        };
        let token_and_repo = if project.repo_provider.as_deref() == Some("github") && body.sha.is_none() {
            git_token_for(&conn, &state.crypto, &project).zip(project.repo_full_name.clone())
        } else {
            None
        };
        (project, branch, target, token_and_repo)
    };

    let mut commit_sha = body.sha.clone();
    let mut commit_message = None;
    let mut commit_author = None;
    let mut commit_url = None;
    if let Some((token, full_name)) = token_and_repo {
        if let Some(head) = github::branch_head(&state.config.github.api_url, &token, &full_name, &branch).await {
            commit_sha = Some(head.sha);
            commit_message = Some(head.message);
            commit_author = Some(head.author);
            commit_url = Some(head.url);
        }
    }

    let conn = state.db.lock();
    let deployment = create_deployment(
        &conn,
        &state.config,
        &project,
        CreateDeploymentInput {
            target,
            source: "manual",
            branch: Some(branch),
            commit_sha,
            commit_message,
            commit_author,
            commit_url,
            created_by: Some(user.user.id.clone()),
            meta: Some(json!({ "trigger": "manual" })),
            ..Default::default()
        },
    )?;

    Ok((StatusCode::ACCEPTED, Json(json!({ "deployment": serialize_deployment(&conn, &state.config, &deployment) }))))
}

#[derive(Deserialize, Default)]
struct ListDeploymentsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    target: Option<String>,
}

async fn list_deployments(
    _user: AuthUser,
    State(state): State<SharedState>,
    Path(key): Path<String>,
    axum::extract::Query(q): axum::extract::Query<ListDeploymentsQuery>,
) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let limit = q.limit.unwrap_or(30).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = deployments::for_project(&conn, &project.id, limit, offset)?
        .into_iter()
        .filter(|d| q.target.as_deref().map(|t| t == d.target).unwrap_or(true))
        .map(|d| serialize_deployment(&conn, &state.config, &d))
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
    #[serde(rename = "deploymentId")]
    deployment_id: Option<String>,
}

/// Requests served by the proxy for this project. The proxy writes these
/// from its own process, so the dashboard tails them by passing back the
/// highest id it has seen rather than by subscribing to an in-process bus.
async fn project_logs(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>, axum::extract::Query(q): axum::extract::Query<LogsQuery>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let opts = request_logs::ForProjectOptions {
        limit: q.limit.unwrap_or(100),
        since_id: q.since_id.filter(|v| *v >= 0),
        search: q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        errors_only: q.status.as_deref() == Some("error"),
        deployment_id: q.deployment_id.as_deref().filter(|s| !s.is_empty()),
    };
    let rows = request_logs::for_project(&conn, &project.id, &opts)?
        .into_iter()
        .map(|row| json!({
            "id": row.id, "ts": row.ts, "method": row.method, "host": row.host, "path": row.path,
            "status": row.status, "durationMs": row.duration_ms, "kind": row.kind, "message": row.message,
            "deploymentId": row.deployment_id,
        }))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "logs": rows, "total": request_logs::count_for_project(&conn, &project.id)? })))
}

/// Webhook endpoint + secret, for wiring up a repository by hand.
async fn webhook_info(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let secret = match &project.webhook_secret {
        Some(s) => s.clone(),
        None => {
            let s = random_secret(24);
            projects::update(&conn, &project.id, &[("webhook_secret", SqlValue::Text(s.clone()))])?;
            s
        }
    };
    Ok(Json(json!({
        "url": format!("{}/api/webhooks/github", state.config.api_url),
        "secret": secret,
        "contentType": "application/json",
        "events": ["push", "pull_request"],
    })))
}

#[derive(Deserialize, Default)]
struct WebhookRegisterBody {
    url: Option<String>,
}

/// Registers a GitHub webhook so pushes deploy without polling.
#[axum::debug_handler]
async fn register_webhook(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>, Json(body): Json<WebhookRegisterBody>) -> AppResult<Json<Value>> {
    let (full_name, token, url, secret) = {
        let conn = state.db.lock();
        let project = require_project(&conn, &key)?;
        if project.repo_provider.as_deref() != Some("github") || project.repo_full_name.is_none() {
            return Err(AppError::bad_request("not_github", "Project is not connected to GitHub"));
        }
        let full_name = project.repo_full_name.clone().unwrap();
        let Some(token) = git_token_for(&conn, &state.crypto, &project) else {
            return Err(AppError::bad_request("no_integration", "No GitHub token available"));
        };

        let url = body.url.filter(|u| !u.is_empty()).unwrap_or_else(|| format!("{}/api/webhooks/github", state.config.api_url));
        let secret = match &project.webhook_secret {
            Some(s) => s.clone(),
            None => {
                let s = random_secret(24);
                projects::update(&conn, &project.id, &[("webhook_secret", SqlValue::Text(s.clone()))])?;
                s
            }
        };
        (full_name, token, url, secret)
    };

    if let Ok(existing) = github::list_webhooks(&state.config.github.api_url, &token, &full_name).await {
        for (hook_id, hook_url) in existing {
            if hook_url.as_deref() == Some(url.as_str()) {
                let _ = github::delete_webhook(&state.config.github.api_url, &token, &full_name, hook_id).await;
            }
        }
    }

    let hook_id = github::create_webhook(&state.config.github.api_url, &token, &full_name, &url, &secret)
        .await
        .map_err(|e| AppError::bad_request("github_error", e.message))?;

    Ok(Json(json!({ "ok": true, "hookId": hook_id, "url": url })))
}

async fn list_domains(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let rows = aliases::for_project(&conn, &project.id)?
        .into_iter()
        .map(|a| json!({
            "id": a.id, "domain": a.domain, "url": url_for(&state.config, &a.domain),
            "type": a.r#type, "deploymentId": a.deployment_id, "updatedAt": a.updated_at,
        }))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "domains": rows })))
}

#[derive(Deserialize, Default)]
struct AddDomainBody {
    domain: Option<String>,
    #[serde(rename = "deploymentId")]
    deployment_id: Option<String>,
}

fn domain_valid(domain: &str) -> bool {
    !domain.is_empty() && domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

async fn add_domain(_user: AuthUser, State(state): State<SharedState>, Path(key): Path<String>, Json(body): Json<AddDomainBody>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &key)?;
    let domain = body.domain.as_deref().unwrap_or("").trim().to_lowercase();
    if !domain_valid(&domain) {
        return Err(AppError::bad_request("invalid_domain", "A valid domain is required"));
    }

    let existing = aliases::by_domain(&conn, &domain)?;
    if let Some(existing) = &existing {
        if existing.project_id != project.id {
            return Err(AppError::new(StatusCode::CONFLICT, "domain_taken", "Domain is already assigned"));
        }
    }

    let target = body.deployment_id.or_else(|| deployments::current_production(&conn, &project.id).ok().flatten().map(|d| d.id));
    let now = now_ms();
    aliases::upsert(
        &conn,
        &crate::db::types::Alias {
            id: existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(new_alias_id),
            domain: domain.clone(),
            project_id: project.id.clone(),
            deployment_id: target.clone(),
            r#type: "custom".to_string(),
            created_at: existing.as_ref().map(|e| e.created_at).unwrap_or(now),
            updated_at: now,
        },
    )?;

    Ok(Json(json!({ "domain": domain, "url": url_for(&state.config, &domain), "deploymentId": target })))
}

#[derive(Deserialize)]
struct DomainParams {
    key: String,
    domain: String,
}

async fn delete_domain(_user: AuthUser, State(state): State<SharedState>, Path(params): Path<DomainParams>) -> AppResult<Json<Value>> {
    let conn = state.db.lock();
    let project = require_project(&conn, &params.key)?;
    let alias = aliases::by_domain(&conn, &params.domain)?.filter(|a| a.project_id == project.id);
    let Some(alias) = alias else {
        return Err(AppError::not_found("Domain not found"));
    };
    if alias.r#type != "custom" {
        return Err(AppError::bad_request("system_domain", "System domains cannot be removed"));
    }
    aliases::delete(&conn, &alias.id)?;
    Ok(Json(json!({ "ok": true })))
}
