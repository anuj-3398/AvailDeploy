//! Mirrors `apps/builder/src/index.ts` — the orchestration that ties
//! `executor`, `git`, `settings`, `functions` and `detect` together into one
//! complete deployment build. This is what lets `avail-worker` run real
//! builds without any Node process at all (previously `@avail/builder`,
//! called by the Node worker) — see docs/rust-api-migration-plan.md.

pub mod detect;
pub mod executor;
pub mod functions;
pub mod git;
pub mod paths;
pub mod settings;

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::db::types::{Deployment, Project};

use executor::LogFn;
use git::{fetch_source, github_clone_url, CommitInfo, FetchOptions};
use settings::{read_project_config, resolve_output_directory, resolve_settings, ResolveOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildPhase {
    Initializing,
    Cloning,
    Installing,
    Building,
    Collecting,
    Publishing,
}

pub struct BuildInput {
    pub deployment: Deployment,
    pub project: Project,
    /// Decrypted environment variables for this deployment's target.
    pub env: HashMap<String, String>,
    /// Git access token for private repositories.
    pub git_token: Option<String>,
    /// Overrides the repository URL (used for local-path test projects).
    pub repo_url: Option<String>,
    pub log: LogFn,
    pub cancel: CancellationToken,
    pub on_phase: Box<dyn Fn(BuildPhase) + Send + Sync>,
}

#[derive(Serialize)]
pub struct DeploymentManifest {
    #[serde(rename = "deploymentId")]
    pub deployment_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "projectSlug")]
    pub project_slug: String,
    pub target: String,
    pub framework: Option<String>,
    #[serde(rename = "serveMode")]
    pub serve_mode: String,
    #[serde(rename = "startCommand")]
    pub start_command: Option<String>,
    #[serde(rename = "staticDir")]
    pub static_dir: Option<String>,
    #[serde(rename = "functionsDir")]
    pub functions_dir: Option<String>,
    #[serde(rename = "serverDir")]
    pub server_dir: String,
    pub functions: Vec<functions::FunctionEntry>,
    pub config: settings::ProjectConfigFile,
    pub env: HashMap<String, String>,
    #[serde(rename = "nodeVersion")]
    pub node_version: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

pub struct BuildOutput {
    pub commit: CommitInfo,
    pub framework: Option<String>,
    pub serve_mode: String,
    pub start_command: Option<String>,
    pub output_path: Option<String>,
    pub functions: Vec<functions::FunctionEntry>,
    pub duration_ms: i64,
}

/// What `run_build` actually did — a normal build, or nothing at all
/// because the project's "Ignored Build Step" said to skip it.
pub enum BuildOutcome {
    Built(BuildOutput),
    Skipped { commit: CommitInfo },
}

pub struct DeploymentPaths {
    pub dir: PathBuf,
    pub src: PathBuf,
    pub manifest: PathBuf,
}

/// Directory layout for one published deployment.
pub fn deployment_paths(cfg: &Config, deployment_id: &str) -> DeploymentPaths {
    let dir = cfg.deployments_dir.join(deployment_id);
    DeploymentPaths { src: dir.join("src"), manifest: dir.join("manifest.json"), dir }
}

pub struct ProjectWorkspace {
    pub src: PathBuf,
    /// Generated shell scripts, kept out of the git working tree.
    pub scripts: PathBuf,
}

/// Long-lived build workspace for a project, reused by every build. Keeping
/// the checkout, `node_modules` and the framework cache between builds turns
/// a cold install into an incremental one.
pub fn project_workspace(cfg: &Config, project_id: &str) -> ProjectWorkspace {
    let dir = cfg.projects_dir.join(project_id);
    ProjectWorkspace { src: dir.join("src"), scripts: dir.join("scripts") }
}

/// Best-effort prelude that makes the requested Node version and package
/// managers available inside the build shell.
fn toolchain_prelude(node_version: &str) -> String {
    let major = node_version.split(|c: char| !c.is_ascii_digit()).next().filter(|s| !s.is_empty()).unwrap_or("22");
    [
        "export NVM_DIR=\"${NVM_DIR:-$HOME/.nvm}\"".to_string(),
        "# shellcheck disable=SC1091".to_string(),
        "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" >/dev/null 2>&1 || true".to_string(),
        format!("command -v nvm >/dev/null 2>&1 && {{ nvm use {major} >/dev/null 2>&1 || nvm install {major} >/dev/null 2>&1 || true; }}"),
        "corepack enable >/dev/null 2>&1 || true".to_string(),
        "echo \"Node $(node --version) / npm $(npm --version)\"".to_string(),
    ]
    .join("\n")
}

/// System environment exposed to every build, mirroring Vercel's variables
/// so existing projects work unchanged, plus `AVAIL_*` equivalents.
pub fn system_env(deployment: &Deployment, project: &Project, commit: Option<&CommitInfo>) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for (k, v) in [
        ("CI", "1"),
        ("NODE_ENV", "production"),
        ("AVAIL", "1"),
        ("AVAIL_ENV", deployment.target.as_str()),
        ("AVAIL_URL", deployment.url.as_str()),
        ("AVAIL_DEPLOYMENT_ID", deployment.id.as_str()),
        ("AVAIL_PROJECT_ID", project.id.as_str()),
        ("AVAIL_PROJECT_NAME", project.name.as_str()),
        ("AVAIL_TARGET_ENV", deployment.target.as_str()),
        ("VERCEL", "1"),
        ("VERCEL_ENV", deployment.target.as_str()),
        ("VERCEL_URL", deployment.url.as_str()),
        ("VERCEL_TARGET_ENV", deployment.target.as_str()),
        ("NEXT_TELEMETRY_DISABLED", "1"),
        ("TURBO_TELEMETRY_DISABLED", "1"),
        ("ASTRO_TELEMETRY_DISABLED", "1"),
    ] {
        env.insert(k.to_string(), v.to_string());
    }
    if let Some(repo) = &project.repo_full_name {
        env.insert("AVAIL_GIT_REPO_SLUG".to_string(), repo.clone());
        env.insert("VERCEL_GIT_REPO_SLUG".to_string(), repo.clone());
        env.insert("VERCEL_GIT_PROVIDER".to_string(), project.repo_provider.clone().unwrap_or_else(|| "github".to_string()));
    }
    if let Some(branch) = &deployment.branch {
        if !branch.is_empty() {
            env.insert("AVAIL_GIT_COMMIT_REF".to_string(), branch.clone());
            env.insert("VERCEL_GIT_COMMIT_REF".to_string(), branch.clone());
        }
    }
    if let Some(commit) = commit {
        if !commit.sha.is_empty() {
            env.insert("AVAIL_GIT_COMMIT_SHA".to_string(), commit.sha.clone());
            env.insert("VERCEL_GIT_COMMIT_SHA".to_string(), commit.sha.clone());
            env.insert("AVAIL_GIT_COMMIT_MESSAGE".to_string(), commit.message.clone());
            env.insert("VERCEL_GIT_COMMIT_MESSAGE".to_string(), commit.message.clone());
            env.insert("AVAIL_GIT_COMMIT_AUTHOR_NAME".to_string(), commit.author.clone());
            env.insert("VERCEL_GIT_COMMIT_AUTHOR_NAME".to_string(), commit.author.clone());
        }
    }
    env
}

/// Publishes the finished build as an immutable deployment directory. The
/// copy is made with hard links (`cp -al`), so a 300 MB `node_modules`
/// snapshot costs directory entries rather than 300 MB and minutes of I/O.
async fn snapshot(cfg: &Config, work_dir: &std::path::Path, dest_dir: &std::path::Path, script_dir: &std::path::Path, log: LogFn, cancel: CancellationToken) -> Result<(), String> {
    let from = paths::sh_quote(&paths::exec_path_of(cfg, work_dir));
    let to = paths::sh_quote(&paths::exec_path_of(cfg, dest_dir));

    let command = [
        format!("rm -rf {to}"),
        format!("mkdir -p {to}"),
        format!("cp -al {from}/. {to}/ 2>/dev/null || cp -a {from}/. {to}/"),
        format!("rm -rf {to}/.next/cache {to}/.git {to}/.turbo"),
    ]
    .join("\n");

    let result = executor::run(
        cfg,
        executor::RunOptions {
            command,
            cwd: script_dir.parent().unwrap_or(script_dir).to_path_buf(),
            env: HashMap::new(),
            script_dir: script_dir.to_path_buf(),
            label: "snapshot".to_string(),
            timeout_ms: 10 * 60_000,
            cancel,
            log: log.clone(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    if result.code != 0 {
        return Err("Could not publish the build output".to_string());
    }
    Ok(())
}

/// Where a workspace path ends up inside the published deployment.
fn in_snapshot(workspace_src: &std::path::Path, abs: &std::path::Path) -> String {
    match abs.strip_prefix(workspace_src) {
        Ok(rel) if !rel.as_os_str().is_empty() => format!("src/{}", rel.to_string_lossy().replace('\\', "/")),
        _ => "src".to_string(),
    }
}

/// Runs a complete deployment build: fetch source, resolve settings,
/// install, build, then collect the output into an immutable deployment
/// directory.
pub async fn run_build(cfg: &Config, input: BuildInput) -> Result<BuildOutcome, String> {
    let BuildInput { deployment, project, env: input_env, git_token, repo_url, log, cancel, on_phase } = input;
    let started = crate::db::now_ms();
    let paths_out = deployment_paths(cfg, &deployment.id);
    let workspace = project_workspace(cfg, &project.id);

    on_phase(BuildPhase::Initializing);
    let first_build = !workspace.src.join(".git").exists();
    std::fs::create_dir_all(&workspace.src).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&workspace.scripts).map_err(|e| e.to_string())?;

    log("info", &format!("Deploying {} ({})", project.name, deployment.target));
    log(
        "info",
        &format!(
            "Build executor: {}{}",
            cfg.build.executor,
            if cfg.build.executor == "wsl" {
                format!(" · workspace: {}", if cfg.workspace_is_native { "WSL-native" } else { "Windows drive (slow)" })
            } else {
                String::new()
            }
        ),
    );
    if !first_build {
        log("info", "Reusing the project workspace (incremental install and cache)");
    }

    /* --------------------------------------------------------------- clone */
    on_phase(BuildPhase::Cloning);
    let effective_repo_url = repo_url.or_else(|| project.repo_full_name.as_deref().map(github_clone_url));
    let Some(effective_repo_url) = effective_repo_url else {
        return Err("Project has no repository configured".to_string());
    };

    let commit = fetch_source(
        cfg,
        FetchOptions {
            repo_url: effective_repo_url,
            ref_: {
                let b = deployment.branch.clone().unwrap_or_default();
                if b.is_empty() { project.production_branch.clone() } else { b }
            },
            sha: deployment.commit_sha.clone(),
            dir: workspace.src.clone(),
            token: git_token.clone(),
            log: log.clone(),
            cancel: cancel.clone(),
            script_dir: workspace.scripts.clone(),
        },
    )
    .await?;
    log("info", &format!("Checked out {} — {}", &commit.sha[..commit.sha.len().min(7)], commit.message));

    /* ------------------------------------------------------ ignore command */
    // "Ignored Build Step": exit 0 skips the build, any other exit code
    // (including a failure to even run it) proceeds normally.
    if let Some(ignore_command) = project.ignore_command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        log("info", &format!("Running ignore command: {ignore_command}"));
        let result = executor::run(
            cfg,
            executor::RunOptions {
                command: ignore_command.to_string(),
                cwd: workspace.src.clone(),
                env: HashMap::new(),
                script_dir: workspace.scripts.clone(),
                label: "ignore".to_string(),
                timeout_ms: 5 * 60_000,
                cancel: cancel.clone(),
                log: log.clone(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;

        if result.code == 0 {
            log("info", "Ignore command exited 0 — skipping this build");
            return Ok(BuildOutcome::Skipped { commit });
        }
        log("info", &format!("Ignore command exited {} — continuing with the build", result.code));
    }

    /* ------------------------------------------------------------ settings */
    let root_config = read_project_config(&workspace.src)?;
    let resolved = resolve_settings(ResolveOptions {
        repo_dir: &workspace.src,
        project: &project,
        config_file: if project.root_directory.is_some() { None } else { Some(root_config) },
    })?;
    let settings::Resolved { settings, config_file, work_dir, package_manager, detected_framework } = resolved;

    if let Some(detected) = &detected_framework {
        if project.framework.is_none() {
            log("info", &format!("Detected framework: {detected}"));
        }
    }
    log("info", &format!("Root directory: {}", settings.root_directory));
    log("info", &format!("Package manager: {package_manager:?}"));

    let mut env = system_env(&deployment, &project, Some(&commit));
    env.extend(input_env.clone());
    let prelude = toolchain_prelude(&settings.node_version);

    /* ------------------------------------------------------------- install */
    if let Some(install_command) = &settings.install_command {
        on_phase(BuildPhase::Installing);
        log(
            "info",
            if work_dir.join("node_modules").exists() { "Installing dependencies (incremental)" } else { "Installing dependencies" },
        );
        let mut install_env = env.clone();
        install_env.insert("NODE_ENV".to_string(), "development".to_string());
        let result = executor::run(
            cfg,
            executor::RunOptions {
                command: format!("{prelude}\n{install_command}"),
                cwd: work_dir.clone(),
                env: install_env,
                script_dir: workspace.scripts.clone(),
                label: "install".to_string(),
                timeout_ms: cfg.build.timeout_ms,
                cancel: cancel.clone(),
                log: log.clone(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        if result.code != 0 {
            return Err(if result.aborted { "Canceled during install".to_string() } else { format!("Install failed with exit code {}", result.code) });
        }
    } else {
        log("info", "No install command — skipping");
    }

    /* --------------------------------------------------------------- build */
    if let Some(build_command) = &settings.build_command {
        on_phase(BuildPhase::Building);
        log("info", "Running build command");
        let result = executor::run(
            cfg,
            executor::RunOptions {
                command: format!("{prelude}\n{build_command}"),
                cwd: work_dir.clone(),
                env: env.clone(),
                script_dir: workspace.scripts.clone(),
                label: "build".to_string(),
                timeout_ms: cfg.build.timeout_ms,
                cancel: cancel.clone(),
                log: log.clone(),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        if result.code != 0 {
            return Err(if result.aborted { "Canceled during build".to_string() } else { format!("Build failed with exit code {}", result.code) });
        }
    } else {
        log("info", "No build command — serving the repository as-is");
    }

    /* ------------------------------------------------------------ collect */
    on_phase(BuildPhase::Collecting);
    let discovered = functions::discover_functions(&work_dir, cfg.runtime.max_duration_sec);
    if !discovered.is_empty() {
        log("info", &format!("Discovered {} serverless function(s):", discovered.len()));
        for f in &discovered {
            log("info", &format!("  {}  ->  {}", f.route, f.file));
        }
    }

    let serve_mode = settings.serve_mode.clone();
    let mut output_path: Option<String> = None;

    if serve_mode == "static" {
        let output_directory = resolve_output_directory(&work_dir, settings.output_directory.as_deref(), settings.framework.as_deref());
        let static_dir = match &output_directory {
            None => {
                log(
                    "warn",
                    &format!(
                        "No output directory found{} — serving the root directory",
                        settings.output_directory.as_ref().map(|d| format!(" at \"{d}\"")).unwrap_or_default()
                    ),
                );
                in_snapshot(&workspace.src, &work_dir)
            }
            Some(dir) => {
                log("info", &format!("Output directory: {dir}"));
                in_snapshot(&workspace.src, &work_dir.join(dir))
            }
        };
        output_path = Some(static_dir);
    } else {
        if settings.start_command.is_none() {
            return Err(format!(
                "Framework \"{}\" needs a start command. Set \"startCommand\" in avail.json or add a \"start\" script.",
                settings.framework.as_deref().unwrap_or("unknown")
            ));
        }
        output_path = Some(in_snapshot(&workspace.src, &work_dir));
        log("info", &format!("Serve mode: server ({})", settings.start_command.as_deref().unwrap_or("")));
    }

    /* ------------------------------------------------------------ publish */
    on_phase(BuildPhase::Publishing);
    let snapshot_started = crate::db::now_ms();
    std::fs::create_dir_all(&paths_out.dir).map_err(|e| e.to_string())?;
    snapshot(cfg, &workspace.src, &paths_out.src, &workspace.scripts, log.clone(), cancel.clone()).await?;
    log("info", &format!("Published deployment artifacts in {:.1}s", (crate::db::now_ms() - snapshot_started) as f64 / 1000.0));

    let server_dir = in_snapshot(&workspace.src, &work_dir);
    let mut manifest_env = input_env.clone();
    manifest_env.extend(system_env(&deployment, &project, Some(&commit)));
    manifest_env.insert("NODE_ENV".to_string(), "production".to_string());

    let manifest = DeploymentManifest {
        deployment_id: deployment.id.clone(),
        project_id: project.id.clone(),
        project_slug: project.slug.clone(),
        target: deployment.target.clone(),
        framework: settings.framework.clone(),
        serve_mode: serve_mode.clone(),
        start_command: settings.start_command.clone(),
        static_dir: if serve_mode == "static" { output_path.clone() } else { None },
        functions_dir: if discovered.is_empty() { None } else { Some(server_dir.clone()) },
        server_dir,
        functions: discovered.clone(),
        config: config_file,
        env: manifest_env,
        node_version: settings.node_version.clone(),
        created_at: crate::db::now_ms(),
    };
    std::fs::write(&paths_out.manifest, serde_json::to_string_pretty(&manifest).unwrap()).map_err(|e| e.to_string())?;

    let duration_ms = crate::db::now_ms() - started;
    log("info", &format!("Build completed in {:.1}s", duration_ms as f64 / 1000.0));

    Ok(BuildOutcome::Built(BuildOutput {
        commit,
        framework: settings.framework,
        serve_mode,
        start_command: settings.start_command,
        output_path,
        functions: discovered,
        duration_ms,
    }))
}

/// Removes a deployment's directory from disk. Blocking — see
/// `spawn_deployment_cleanup` for why callers holding the DB lock or
/// running on an async worker thread should not call this directly.
pub fn remove_deployment_dir(cfg: &Config, deployment_id: &str) {
    let paths = deployment_paths(cfg, deployment_id);
    let _ = std::fs::remove_dir_all(&paths.dir);
}

/// Deletes each deployment's directory in the background, off the calling
/// task and without any lock held. `remove_dir_all` is a blocking syscall
/// that can take a long time over a WSL UNC path (`\\wsl.localhost\...`) on
/// a `node_modules`-heavy snapshot — directly measured at 2+ minutes for
/// one deployment during testing. Doing this synchronously while holding
/// `state.db.lock()` blocks *every other request in the whole app* for
/// that entire time, since the DB is one process-wide mutex every
/// handler — including the SSE polling loops — needs to touch.
/// `spawn_blocking` per directory keeps it off the async worker threads
/// too, so a slow delete can't even starve unrelated tasks.
pub fn spawn_deployment_cleanup(deployments_dir: std::path::PathBuf, deployment_ids: Vec<String>) {
    tokio::spawn(async move {
        for id in deployment_ids {
            let dir = deployments_dir.join(&id);
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir)).await;
        }
    });
}

/// Verifies the configured executor can run commands at all.
pub async fn check_executor(cfg: &Config) -> (bool, String) {
    executor::check_executor(cfg).await
}
