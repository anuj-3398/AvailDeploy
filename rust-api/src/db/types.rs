//! Mirrors `packages/shared/src/types.ts`. Field names and types (SQLite
//! `INTEGER` booleans stay `i64`, exactly like the TS `number` fields they
//! mirror) match the schema column-for-column.

use rusqlite::Row;
use serde::Serialize;

pub trait FromRow: Sized {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self>;
}

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
}

impl FromRow for User {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(User {
            id: row.get("id")?,
            email: row.get("email")?,
            name: row.get("name")?,
            avatar_url: row.get("avatar_url")?,
            role: row.get("role")?,
            created_at: row.get("created_at")?,
            last_login_at: row.get("last_login_at")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub user_agent: Option<String>,
}

impl FromRow for Session {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Session {
            id: row.get("id")?,
            user_id: row.get("user_id")?,
            created_at: row.get("created_at")?,
            expires_at: row.get("expires_at")?,
            user_agent: row.get("user_agent")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct LoginCode {
    pub id: String,
    pub email: String,
    pub code_hash: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub consumed_at: Option<i64>,
    pub attempts: i64,
}

impl FromRow for LoginCode {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(LoginCode {
            id: row.get("id")?,
            email: row.get("email")?,
            code_hash: row.get("code_hash")?,
            created_at: row.get("created_at")?,
            expires_at: row.get("expires_at")?,
            consumed_at: row.get("consumed_at")?,
            attempts: row.get("attempts")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct GitIntegration {
    pub id: String,
    pub user_id: String,
    pub provider: String,
    pub kind: String,
    pub login: String,
    pub avatar_url: Option<String>,
    /// AES-256-GCM encrypted access token.
    pub token_enc: String,
    pub scopes: Option<String>,
    pub created_at: i64,
}

impl FromRow for GitIntegration {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(GitIntegration {
            id: row.get("id")?,
            user_id: row.get("user_id")?,
            provider: row.get("provider")?,
            kind: row.get("kind")?,
            login: row.get("login")?,
            avatar_url: row.get("avatar_url")?,
            token_enc: row.get("token_enc")?,
            scopes: row.get("scopes")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub framework: Option<String>,
    pub root_directory: Option<String>,
    pub install_command: Option<String>,
    pub build_command: Option<String>,
    pub output_directory: Option<String>,
    pub dev_command: Option<String>,
    pub node_version: String,
    pub serve_mode: Option<String>,
    pub repo_provider: Option<String>,
    pub repo_full_name: Option<String>,
    pub repo_id: Option<String>,
    pub repo_default_branch: Option<String>,
    pub production_branch: String,
    pub auto_deploy: i64,
    pub preview_deploys: i64,
    pub git_integration_id: Option<String>,
    pub webhook_secret: Option<String>,
    /// "Ignored Build Step": a shell command run after checkout. Exit 0
    /// skips the build entirely (a deployment lands `SKIPPED`); any other
    /// exit code proceeds normally. `None`/empty never skips.
    pub ignore_command: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl FromRow for Project {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Project {
            id: row.get("id")?,
            name: row.get("name")?,
            slug: row.get("slug")?,
            framework: row.get("framework")?,
            root_directory: row.get("root_directory")?,
            install_command: row.get("install_command")?,
            build_command: row.get("build_command")?,
            output_directory: row.get("output_directory")?,
            dev_command: row.get("dev_command")?,
            node_version: row.get("node_version")?,
            serve_mode: row.get("serve_mode")?,
            repo_provider: row.get("repo_provider")?,
            repo_full_name: row.get("repo_full_name")?,
            repo_id: row.get("repo_id")?,
            repo_default_branch: row.get("repo_default_branch")?,
            production_branch: row.get("production_branch")?,
            auto_deploy: row.get("auto_deploy")?,
            preview_deploys: row.get("preview_deploys")?,
            git_integration_id: row.get("git_integration_id")?,
            webhook_secret: row.get("webhook_secret")?,
            ignore_command: row.get("ignore_command")?,
            created_by: row.get("created_by")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct EnvVar {
    pub id: String,
    pub project_id: String,
    pub key: String,
    pub value_enc: String,
    pub target: String,
    pub git_branch: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub created_by: Option<String>,
}

impl FromRow for EnvVar {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(EnvVar {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            key: row.get("key")?,
            value_enc: row.get("value_enc")?,
            target: row.get("target")?,
            git_branch: row.get("git_branch")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            created_by: row.get("created_by")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Deployment {
    pub id: String,
    pub project_id: String,
    pub state: String,
    pub target: String,
    pub source: String,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub commit_message: Option<String>,
    pub commit_author: Option<String>,
    pub commit_url: Option<String>,
    pub pr_number: Option<i64>,
    pub url: String,
    pub framework: Option<String>,
    pub serve_mode: Option<String>,
    pub start_command: Option<String>,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub building_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub build_duration_ms: Option<i64>,
    pub is_current_production: i64,
    pub meta: Option<String>,
}

impl FromRow for Deployment {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Deployment {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            state: row.get("state")?,
            target: row.get("target")?,
            source: row.get("source")?,
            branch: row.get("branch")?,
            commit_sha: row.get("commit_sha")?,
            commit_message: row.get("commit_message")?,
            commit_author: row.get("commit_author")?,
            commit_url: row.get("commit_url")?,
            pr_number: row.get("pr_number")?,
            url: row.get("url")?,
            framework: row.get("framework")?,
            serve_mode: row.get("serve_mode")?,
            start_command: row.get("start_command")?,
            output_path: row.get("output_path")?,
            error: row.get("error")?,
            created_by: row.get("created_by")?,
            created_at: row.get("created_at")?,
            building_at: row.get("building_at")?,
            ready_at: row.get("ready_at")?,
            build_duration_ms: row.get("build_duration_ms")?,
            is_current_production: row.get("is_current_production")?,
            meta: row.get("meta")?,
        })
    }
}

/// `deployments.recent()`'s join shape: a `Deployment` plus the owning
/// project's slug/name.
#[derive(Debug, Clone)]
pub struct DeploymentWithProject {
    pub deployment: Deployment,
    pub project_slug: String,
    pub project_name: String,
}

impl FromRow for DeploymentWithProject {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(DeploymentWithProject {
            deployment: Deployment::from_row(row)?,
            project_slug: row.get("project_slug")?,
            project_name: row.get("project_name")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct BuildLog {
    pub id: i64,
    pub deployment_id: String,
    pub seq: i64,
    pub ts: i64,
    pub level: String,
    pub text: String,
}

impl FromRow for BuildLog {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(BuildLog {
            id: row.get("id")?,
            deployment_id: row.get("deployment_id")?,
            seq: row.get("seq")?,
            ts: row.get("ts")?,
            level: row.get("level")?,
            text: row.get("text")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Alias {
    pub id: String,
    pub domain: String,
    pub project_id: String,
    pub deployment_id: Option<String>,
    pub r#type: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl FromRow for Alias {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Alias {
            id: row.get("id")?,
            domain: row.get("domain")?,
            project_id: row.get("project_id")?,
            deployment_id: row.get("deployment_id")?,
            r#type: row.get("type")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct RequestLog {
    pub id: i64,
    pub project_id: String,
    pub deployment_id: Option<String>,
    pub ts: i64,
    pub method: String,
    pub host: String,
    pub path: String,
    pub status: i64,
    pub duration_ms: i64,
    pub kind: String,
    pub message: Option<String>,
}

impl FromRow for RequestLog {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(RequestLog {
            id: row.get("id")?,
            project_id: row.get("project_id")?,
            deployment_id: row.get("deployment_id")?,
            ts: row.get("ts")?,
            method: row.get("method")?,
            host: row.get("host")?,
            path: row.get("path")?,
            status: row.get("status")?,
            duration_ms: row.get("duration_ms")?,
            kind: row.get("kind")?,
            message: row.get("message")?,
        })
    }
}

/// A comment on one deployment — dashboard-only, `apps/proxy` never reads
/// this table. See `db::comments`.
#[derive(Debug, Clone)]
pub struct DeploymentComment {
    pub id: String,
    pub deployment_id: String,
    pub user_id: String,
    pub body: String,
    pub created_at: i64,
}

impl FromRow for DeploymentComment {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(DeploymentComment {
            id: row.get("id")?,
            deployment_id: row.get("deployment_id")?,
            user_id: row.get("user_id")?,
            body: row.get("body")?,
            created_at: row.get("created_at")?,
        })
    }
}
