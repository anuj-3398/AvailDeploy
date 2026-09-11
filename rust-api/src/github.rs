//! Mirrors `apps/api/src/lib/github.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::GithubConfig;

#[derive(Debug)]
pub struct GitHubError {
    pub message: String,
    pub status: u16,
}

impl std::fmt::Display for GitHubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for GitHubError {}

#[derive(Debug, Clone, Deserialize)]
pub struct GhUser {
    pub login: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GhOwner {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhPermissions {
    #[serde(default)]
    pub admin: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhRepo {
    pub id: i64,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub html_url: String,
    pub description: Option<String>,
    pub default_branch: String,
    pub pushed_at: String,
    pub owner: GhOwner,
    pub permissions: Option<GhPermissions>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhBranch {
    pub name: String,
    pub commit: GhBranchCommit,
}
#[derive(Debug, Clone, Deserialize)]
pub struct GhBranchCommit {
    pub sha: String,
}

#[derive(Debug, Clone)]
pub struct BranchHead {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub url: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().user_agent("avail-deploy").build().expect("build reqwest client")
}

async fn request(
    api_url: &str,
    token: &str,
    method: reqwest::Method,
    endpoint: &str,
    body: Option<Value>,
) -> Result<Value, GitHubError> {
    let url = if endpoint.starts_with("http") { endpoint.to_string() } else { format!("{api_url}{endpoint}") };
    let mut req = client()
        .request(method, &url)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = &body {
        req = req.json(body);
    }

    let response = req.send().await.map_err(|e| GitHubError { message: e.to_string(), status: 0 })?;
    let status = response.status();
    if status.as_u16() == 204 {
        return Ok(Value::Null);
    }
    let text = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));

    if !status.is_success() {
        let message = parsed.get("message").and_then(|m| m.as_str()).unwrap_or("GitHub request failed");
        return Err(GitHubError { message: format!("{message} ({} {endpoint})", status.as_u16()), status: status.as_u16() });
    }
    Ok(parsed)
}

async fn get(api_url: &str, token: &str, endpoint: &str) -> Result<Value, GitHubError> {
    request(api_url, token, reqwest::Method::GET, endpoint, None).await
}

pub async fn user(api_url: &str, token: &str) -> Result<GhUser, GitHubError> {
    let v = get(api_url, token, "/user").await?;
    serde_json::from_value(v).map_err(|e| GitHubError { message: e.to_string(), status: 0 })
}

/// Primary verified email, which is what the domain allow-list checks.
pub async fn primary_email(api_url: &str, token: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Entry {
        email: String,
        primary: bool,
        verified: bool,
    }
    let v = get(api_url, token, "/user/emails").await.ok()?;
    let emails: Vec<Entry> = serde_json::from_value(v).ok()?;
    emails
        .iter()
        .find(|e| e.primary && e.verified)
        .or_else(|| emails.iter().find(|e| e.verified))
        .map(|e| e.email.clone())
}

pub async fn repos(api_url: &str, token: &str, page: i64) -> Result<Vec<GhRepo>, GitHubError> {
    let endpoint = format!(
        "/user/repos?per_page=100&page={page}&sort=pushed&affiliation=owner,collaborator,organization_member"
    );
    let v = get(api_url, token, &endpoint).await?;
    serde_json::from_value(v).map_err(|e| GitHubError { message: e.to_string(), status: 0 })
}

pub async fn repo(api_url: &str, token: &str, full_name: &str) -> Result<GhRepo, GitHubError> {
    let v = get(api_url, token, &format!("/repos/{full_name}")).await?;
    serde_json::from_value(v).map_err(|e| GitHubError { message: e.to_string(), status: 0 })
}

pub async fn branches(api_url: &str, token: &str, full_name: &str) -> Result<Vec<GhBranch>, GitHubError> {
    let v = get(api_url, token, &format!("/repos/{full_name}/branches?per_page=100")).await?;
    serde_json::from_value(v).map_err(|e| GitHubError { message: e.to_string(), status: 0 })
}

/// Latest commit on a branch, or `None` when the branch does not exist.
pub async fn branch_head(api_url: &str, token: &str, full_name: &str, branch: &str) -> Option<BranchHead> {
    let encoded = urlencoding::encode(branch);
    let v = get(api_url, token, &format!("/repos/{full_name}/commits/{encoded}")).await.ok()?;
    let sha = v.get("sha")?.as_str()?.to_string();
    let html_url = v.get("html_url")?.as_str()?.to_string();
    let commit = v.get("commit")?;
    let message = commit.get("message")?.as_str()?.split('\n').next().unwrap_or("").to_string();
    let author = commit.get("author")?;
    let name = author.get("name").and_then(|n| n.as_str()).unwrap_or("");
    let email = author.get("email").and_then(|n| n.as_str()).unwrap_or("");
    Some(BranchHead { sha, message, author: format!("{name} <{email}>"), url: html_url })
}

pub async fn create_webhook(api_url: &str, token: &str, full_name: &str, url: &str, secret: &str) -> Result<i64, GitHubError> {
    let body = json!({
        "name": "web",
        "active": true,
        "events": ["push", "pull_request"],
        "config": { "url": url, "content_type": "json", "secret": secret, "insecure_ssl": "0" },
    });
    let v = request(api_url, token, reqwest::Method::POST, &format!("/repos/{full_name}/hooks"), Some(body)).await?;
    Ok(v.get("id").and_then(|i| i.as_i64()).unwrap_or(0))
}

pub async fn list_webhooks(api_url: &str, token: &str, full_name: &str) -> Result<Vec<(i64, Option<String>)>, GitHubError> {
    let v = get(api_url, token, &format!("/repos/{full_name}/hooks")).await?;
    let arr = v.as_array().cloned().unwrap_or_default();
    Ok(arr
        .into_iter()
        .map(|hook| {
            let id = hook.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
            let url = hook.get("config").and_then(|c| c.get("url")).and_then(|u| u.as_str()).map(str::to_string);
            (id, url)
        })
        .collect())
}

pub async fn delete_webhook(api_url: &str, token: &str, full_name: &str, hook_id: i64) -> Result<(), GitHubError> {
    request(api_url, token, reqwest::Method::DELETE, &format!("/repos/{full_name}/hooks/{hook_id}"), None).await?;
    Ok(())
}

/// Reports deployment status back onto the commit in GitHub. Unused in this
/// binary today — that's `apps/worker`'s job, using its own copy of
/// `lib/github.ts`, once a build actually finishes. Ported for parity.
#[allow(dead_code)]
pub async fn create_commit_status(
    api_url: &str,
    token: &str,
    full_name: &str,
    sha: &str,
    state: &str,
    target_url: &str,
    description: &str,
    context: &str,
) -> Result<(), GitHubError> {
    let body = json!({
        "context": context,
        "state": state,
        "target_url": target_url,
        "description": description,
    });
    request(api_url, token, reqwest::Method::POST, &format!("/repos/{full_name}/statuses/{sha}"), Some(body)).await?;
    Ok(())
}

/// Also unused here for the same reason as `create_commit_status`.
#[allow(dead_code)]
pub async fn comment_on_pull_request(api_url: &str, token: &str, full_name: &str, pr_number: i64, body_text: &str) -> Result<(), GitHubError> {
    let body = json!({ "body": body_text });
    request(api_url, token, reqwest::Method::POST, &format!("/repos/{full_name}/issues/{pr_number}/comments"), Some(body)).await?;
    Ok(())
}

/// Exchanges an OAuth callback code for an access token.
pub async fn exchange_oauth_code(cfg: &GithubConfig, code: &str, redirect_uri: &str) -> Result<String, GitHubError> {
    let (Some(client_id), Some(client_secret)) = (&cfg.client_id, &cfg.client_secret) else {
        return Err(GitHubError { message: "GitHub OAuth is not configured".into(), status: 500 });
    };
    let response = client()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        }))
        .send()
        .await
        .map_err(|e| GitHubError { message: e.to_string(), status: 0 })?;
    let body: Value = response.json().await.unwrap_or(Value::Null);
    match body.get("access_token").and_then(|t| t.as_str()) {
        Some(token) => Ok(token.to_string()),
        None => {
            let desc = body.get("error_description").and_then(|d| d.as_str()).unwrap_or("OAuth exchange failed");
            Err(GitHubError { message: desc.to_string(), status: 400 })
        }
    }
}

pub fn oauth_authorize_url(cfg: &GithubConfig, redirect_uri: &str, state: &str) -> String {
    let client_id = cfg.client_id.as_deref().unwrap_or("");
    format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope={}&state={}",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode("repo read:user user:email admin:repo_hook"),
        urlencoding::encode(state),
    )
}
