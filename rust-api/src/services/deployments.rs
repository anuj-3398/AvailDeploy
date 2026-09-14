//! Mirrors `apps/api/src/services/deployments.ts`. The one behavioral
//! difference: `create_deployment` does not enqueue anything in-process —
//! there is no in-process queue here. It inserts the `QUEUED` row and
//! `apps/worker` (Node, polling `deployments.queued()`) picks it up, same
//! as `queue.recoverOnBoot()` already did for crash recovery before this
//! split. See `docs/rust-api-migration-plan.md`.
//!
//! `assign_aliases` and `env_for_deployment` have no caller in this binary
//! today — finishing a build (assigning its aliases, gathering its env) is
//! `apps/worker`'s job, and it keeps its own copy of this same logic in
//! TypeScript rather than shelling out to Rust for it. They're ported here
//! anyway, tested, so the two stay obviously in sync and so Rust already
//! has this logic ready if build-finalization ever moves into this process.

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::config::Config;
use crate::crypto::Crypto;
use crate::db::types::{Deployment, Project};
use crate::db::{aliases, deployments, env_vars, events, integrations, now_ms, projects};
use crate::error::AppError;
use crate::ids::{new_alias_id, new_deployment_id, short_hash, slugify};

pub fn url_for(cfg: &Config, host: &str) -> String {
    let port = if cfg.proxy_port == 80 { String::new() } else { format!(":{}", cfg.proxy_port) };
    format!("{}://{host}{port}", cfg.deployment_scheme)
}

pub fn deployment_host(cfg: &Config, project_slug: &str) -> String {
    format!("{project_slug}-{}.{}", short_hash(7), cfg.deployment_domain)
}

pub fn production_host(cfg: &Config, project_slug: &str) -> String {
    format!("{project_slug}.{}", cfg.deployment_domain)
}

#[allow(dead_code)] // only reachable via assign_aliases — see the module doc comment
pub fn branch_host(cfg: &Config, project_slug: &str, branch: &str) -> String {
    format!("{project_slug}-git-{}.{}", slugify(branch), cfg.deployment_domain)
}

fn upsert_alias(
    conn: &Connection,
    domain: &str,
    project_id: &str,
    deployment_id: Option<&str>,
    kind: &str,
) -> rusqlite::Result<()> {
    let now = now_ms();
    aliases::upsert(
        conn,
        &crate::db::types::Alias {
            id: new_alias_id(),
            domain: domain.to_string(),
            project_id: project_id.to_string(),
            deployment_id: deployment_id.map(str::to_string),
            r#type: kind.to_string(),
            created_at: now,
            updated_at: now,
        },
    )?;
    Ok(())
}

#[derive(Default)]
pub struct CreateDeploymentInput {
    pub target: &'static str,
    pub source: &'static str,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub commit_message: Option<String>,
    pub commit_author: Option<String>,
    pub commit_url: Option<String>,
    pub pr_number: Option<i64>,
    pub created_by: Option<String>,
    pub meta: Option<Value>,
}

/// Registers a deployment in `QUEUED` state and reserves its immutable
/// hostname. Building it is `apps/worker`'s job, not this process's.
pub fn create_deployment(
    conn: &Connection,
    cfg: &Config,
    project: &Project,
    input: CreateDeploymentInput,
) -> Result<Deployment, AppError> {
    let id = new_deployment_id();
    let host = deployment_host(cfg, &project.slug);
    let branch = input.branch.unwrap_or_else(|| project.production_branch.clone());

    let created = deployments::create(
        conn,
        &Deployment {
            id: id.clone(),
            project_id: project.id.clone(),
            state: "QUEUED".to_string(),
            target: input.target.to_string(),
            source: input.source.to_string(),
            branch: Some(branch.clone()),
            commit_sha: input.commit_sha,
            commit_message: input.commit_message,
            commit_author: input.commit_author,
            commit_url: input.commit_url,
            pr_number: input.pr_number,
            url: host.clone(),
            framework: project.framework.clone(),
            serve_mode: None,
            start_command: None,
            output_path: None,
            error: None,
            created_by: input.created_by.clone(),
            created_at: now_ms(),
            building_at: None,
            ready_at: None,
            build_duration_ms: None,
            is_current_production: 0,
            meta: input.meta.map(|m| m.to_string()),
        },
    )?;

    upsert_alias(conn, &host, &project.id, Some(&id), "deployment")?;

    events::record(
        conn,
        events::NewEvent {
            r#type: "deployment.created",
            text: &format!(
                "{} deployment queued for {branch}",
                if input.target == "production" { "Production" } else { "Preview" }
            ),
            project_id: Some(&project.id),
            deployment_id: Some(&id),
            user_id: input.created_by.as_deref(),
        },
    )?;

    Ok(created)
}

/// Points the branch alias (and, for production deployments, the project's
/// production domain) at a finished deployment.
#[allow(dead_code)]
pub fn assign_aliases(conn: &Connection, cfg: &Config, deployment: &Deployment, project: &Project) -> rusqlite::Result<Vec<String>> {
    let mut assigned = vec![deployment.url.clone()];

    if let Some(branch) = &deployment.branch {
        let host = branch_host(cfg, &project.slug, branch);
        upsert_alias(conn, &host, &project.id, Some(&deployment.id), "branch")?;
        assigned.push(host);
    }

    if deployment.target == "production" {
        let host = production_host(cfg, &project.slug);
        upsert_alias(conn, &host, &project.id, Some(&deployment.id), "production")?;
        deployments::promote(conn, &project.id, &deployment.id)?;
        assigned.push(host);
    }

    Ok(assigned)
}

/// Points the production domain at an existing READY deployment.
pub fn promote_to_production(
    conn: &Connection,
    cfg: &Config,
    deployment: &Deployment,
    project: &Project,
    user_id: Option<&str>,
) -> Result<Vec<String>, AppError> {
    if deployment.state != "READY" {
        return Err(AppError::bad_request("not_ready", "Only READY deployments can be promoted"));
    }
    let host = production_host(cfg, &project.slug);
    upsert_alias(conn, &host, &project.id, Some(&deployment.id), "production")?;
    deployments::promote(conn, &project.id, &deployment.id)?;
    deployments::update(conn, &deployment.id, &[("target", rusqlite::types::Value::Text("production".into()))])?;

    events::record(
        conn,
        events::NewEvent {
            r#type: "deployment.promoted",
            text: &format!("Promoted {} to production", deployment.id),
            project_id: Some(&project.id),
            deployment_id: Some(&deployment.id),
            user_id,
        },
    )?;

    Ok(vec![host, deployment.url.clone()])
}

/// Decrypted environment variables that apply to a deployment. Branch-
/// specific values are ordered last so they overwrite the defaults.
#[allow(dead_code)]
pub fn env_for_deployment(
    conn: &Connection,
    crypto: &Crypto,
    project_id: &str,
    target: &str,
    branch: Option<&str>,
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut rows = env_vars::for_build(conn, project_id, target, branch)?;
    rows.reverse();
    let mut env = std::collections::HashMap::new();
    for row in rows {
        if let Some(value) = crypto.try_decrypt(&row.value_enc, "env") {
            env.insert(row.key, value);
        }
    }
    Ok(env)
}

/// Git access token for a project, falling back to any workspace token.
pub fn git_token_for(conn: &Connection, crypto: &Crypto, project: &Project) -> Option<String> {
    let integration = match &project.git_integration_id {
        Some(id) => integrations::by_id(conn, id).ok().flatten(),
        None => integrations::any(conn).ok().flatten(),
    }?;
    crypto.try_decrypt(&integration.token_enc, "git-token")
}

/// Public JSON shape returned by the API for a deployment.
pub fn serialize_deployment(conn: &Connection, cfg: &Config, deployment: &Deployment) -> Value {
    let project = projects::by_id(conn, &deployment.project_id).ok().flatten();
    let alias_list = aliases::for_deployment(conn, &deployment.id).unwrap_or_default();

    json!({
        "id": deployment.id,
        "projectId": deployment.project_id,
        "projectSlug": project.as_ref().map(|p| p.slug.clone()),
        "projectName": project.as_ref().map(|p| p.name.clone()),
        "state": deployment.state,
        "target": deployment.target,
        "source": deployment.source,
        "branch": deployment.branch,
        "commit": deployment.commit_sha.as_ref().map(|sha| json!({
            "sha": sha,
            "shortSha": &sha[..sha.len().min(7)],
            "message": deployment.commit_message,
            "author": deployment.commit_author,
            "url": deployment.commit_url,
        })),
        "prNumber": deployment.pr_number,
        "url": url_for(cfg, &deployment.url),
        "host": deployment.url,
        "aliases": alias_list.iter().map(|a| json!({
            "domain": a.domain,
            "url": url_for(cfg, &a.domain),
            "type": a.r#type,
        })).collect::<Vec<_>>(),
        "framework": deployment.framework,
        "serveMode": deployment.serve_mode,
        "error": deployment.error,
        "isCurrentProduction": deployment.is_current_production != 0,
        "createdAt": deployment.created_at,
        "buildingAt": deployment.building_at,
        "readyAt": deployment.ready_at,
        "buildDurationMs": deployment.build_duration_ms,
        "createdBy": deployment.created_by,
    })
}
