//! Mirrors `apps/builder/src/git.ts`.

use std::collections::HashMap;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::builder::executor::{run, LogFn, RunOptions};
use crate::builder::paths::{exec_path, sh_quote};
use crate::config::Config;

#[derive(Debug, Clone)]
pub struct CommitInfo {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub ref_: String,
}

pub struct FetchOptions {
    /// `https://github.com/owner/repo.git`, or an absolute local path.
    pub repo_url: String,
    /// Branch, tag or commit-ish to check out.
    pub ref_: String,
    /// Exact commit to check out, when known.
    pub sha: Option<String>,
    pub dir: PathBuf,
    pub token: Option<String>,
    pub log: LogFn,
    pub cancel: CancellationToken,
    pub script_dir: PathBuf,
}

/// Strips credentials so tokens never reach the build log.
pub fn redact_url(url: &str) -> String {
    let re = regex::Regex::new(r"//[^@/]+@").unwrap();
    re.replace(url, "//***@").to_string()
}

fn is_local_path(repo_url: &str) -> bool {
    repo_url.starts_with('/')
        || repo_url.starts_with("file://")
        || regex::Regex::new(r"^[A-Za-z]:[\\/]").unwrap().is_match(repo_url)
}

/// Clones `repo_url` at `ref_` into `dir` and reports the resolved commit.
/// Runs through the build executor so the checkout happens in the same
/// environment the build will run in.
pub async fn fetch_source(cfg: &Config, options: FetchOptions) -> Result<CommitInfo, String> {
    let target = options.sha.clone().unwrap_or_else(|| options.ref_.clone());
    let depth = "--depth 1";

    let remote = if is_local_path(&options.repo_url) {
        exec_path(cfg, options.repo_url.trim_start_matches("file://"))
    } else {
        options.repo_url.clone()
    };

    (options.log)("info", &format!("Cloning {} ({target})", redact_url(&remote)));

    let commit_file = options.dir.join(".avail-commit.txt");
    let credential_setup = if options.token.is_some() && !is_local_path(&options.repo_url) {
        format!(
            "git config credential.helper {}\ngit config http.version HTTP/1.1",
            sh_quote(r#"!f() { echo "username=x-access-token"; echo "password=$AVAIL_GIT_TOKEN"; }; f"#)
        )
    } else {
        String::new()
    };

    let script = [
        "if [ -d .git ]; then".to_string(),
        format!(
            "  git remote set-url origin {} 2>/dev/null || git remote add origin {}",
            sh_quote(&remote),
            sh_quote(&remote)
        ),
        "else".to_string(),
        "  rm -rf .git".to_string(),
        "  git init -q .".to_string(),
        format!("  git remote add origin {}", sh_quote(&remote)),
        "fi".to_string(),
        credential_setup,
        format!(
            "git fetch -q {depth} origin {} || git fetch -q {depth} origin",
            sh_quote(&target)
        ),
        "git checkout -q --force FETCH_HEAD".to_string(),
        "git clean -qfd -e node_modules".to_string(),
        "git submodule update --init --recursive --depth 1 2>/dev/null || true".to_string(),
        format!(
            "git log -1 --pretty=format:'%H%n%an <%ae>%n%s' > {}",
            sh_quote(".avail-commit.txt")
        ),
    ]
    .into_iter()
    .filter(|l| !l.is_empty())
    .collect::<Vec<_>>()
    .join("\n");

    let mut env = HashMap::new();
    if let Some(token) = &options.token {
        env.insert("AVAIL_GIT_TOKEN".to_string(), token.clone());
    }

    let result = run(
        cfg,
        RunOptions {
            command: script,
            cwd: options.dir.clone(),
            env,
            script_dir: options.script_dir.clone(),
            label: "fetch".to_string(),
            timeout_ms: cfg.build.timeout_ms,
            cancel: options.cancel.clone(),
            log: options.log.clone(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // The script embeds credentials; remove it as soon as it has run.
    let script_path = options.script_dir.join(".avail-fetch.sh");
    let _ = std::fs::remove_file(&script_path);

    if result.code != 0 {
        return Err(if result.aborted {
            "Canceled while fetching source".to_string()
        } else {
            format!("Failed to fetch {} at {target}", redact_url(&remote))
        });
    }

    if !commit_file.exists() {
        return Err("Checkout succeeded but no commit metadata was produced".to_string());
    }
    let contents = std::fs::read_to_string(&commit_file).unwrap_or_default();
    let mut parts = contents.trim().split('\n');
    let sha = parts.next().unwrap_or("").trim().to_string();
    let author = parts.next().unwrap_or("").trim().to_string();
    let message = parts.collect::<Vec<_>>().join("\n").trim().to_string();
    let _ = std::fs::remove_file(&commit_file);

    Ok(CommitInfo { sha, author, message, ref_: options.ref_.clone() })
}

/// Builds an authenticated HTTPS clone URL for a GitHub repository.
pub fn github_clone_url(full_name: &str) -> String {
    format!("https://github.com/{full_name}.git")
}

