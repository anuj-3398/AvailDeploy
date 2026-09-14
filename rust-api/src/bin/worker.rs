//! `avail-worker` — the pure-Rust replacement for `apps/worker` (Node).
//! Polls `deployments` for `QUEUED` rows and builds them with
//! `avail_api::builder::run_build`, which needs no Node process at all
//! (previously `@avail/builder`). See docs/rust-api-migration-plan.md.
//!
//! Coordinates with `avail-api` (or the Node API, if that's what's
//! inserting rows) purely through the shared SQLite database — no HTTP, no
//! IPC. Same "one build per project at a time" rule as the Node queue, and
//! the same `cancelRequested`-in-`meta` cross-process cancellation flag.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use avail_api::builder::{self, executor::LogFn, BuildInput, BuildOutcome, BuildPhase};
use avail_api::config::{self, Config};
use avail_api::crypto::Crypto;
use avail_api::db::types::{Deployment, Project};
use avail_api::db::{self, deployments, env_vars, events, integrations, notifications, projects, Db};
use avail_api::github;
use avail_api::ids::new_alias_id;
use avail_api::logger;

const PHASE_STATE: &[(BuildPhase, &str)] = &[
    (BuildPhase::Initializing, "INITIALIZING"),
    (BuildPhase::Cloning, "INITIALIZING"),
    (BuildPhase::Installing, "BUILDING"),
    (BuildPhase::Building, "BUILDING"),
    (BuildPhase::Collecting, "UPLOADING"),
    (BuildPhase::Publishing, "UPLOADING"),
];

fn phase_state(phase: BuildPhase) -> &'static str {
    PHASE_STATE.iter().find(|(p, _)| *p == phase).map(|(_, s)| *s).unwrap_or("BUILDING")
}

struct Worker {
    db: Db,
    crypto: Crypto,
    config: Config,
    running: Mutex<HashMap<String, CancellationToken>>,
    running_projects: Mutex<HashSet<String>>,
    semaphore: Arc<Semaphore>,
}

fn url_for(cfg: &Config, host: &str) -> String {
    let port = if cfg.proxy_port == 80 { String::new() } else { format!(":{}", cfg.proxy_port) };
    format!("{}://{host}{port}", cfg.deployment_scheme)
}

fn production_host(cfg: &Config, slug: &str) -> String {
    format!("{slug}.{}", cfg.deployment_domain)
}

fn branch_host(cfg: &Config, slug: &str, branch: &str) -> String {
    format!("{slug}-git-{}.{}", avail_api::ids::slugify(branch), cfg.deployment_domain)
}

impl Worker {
    fn log_sink(self: &Arc<Self>, deployment_id: String) -> LogFn {
        let this = self.clone();
        let seq = Arc::new(std::sync::atomic::AtomicI64::new({
            let conn = this.db.lock();
            avail_api::db::build_logs::max_seq(&conn, &deployment_id).unwrap_or(-1) + 1
        }));
        Arc::new(move |level, text| {
            let s = seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let level = match level {
                "stdout" | "stderr" | "command" | "warn" | "error" => level,
                _ => "info",
            };
            let text = if text.len() > 8000 { format!("{}… (truncated)", &text[..8000]) } else { text.to_string() };
            let conn = this.db.lock();
            let _ = avail_api::db::build_logs::append(&conn, &deployment_id, level, &text, s);
        })
    }

    fn publish_note(&self, level: &str, deployment_id: &str, text: &str) {
        let seq = {
            let conn = self.db.lock();
            avail_api::db::build_logs::max_seq(&conn, deployment_id).unwrap_or(-1) + 1
        };
        let conn = self.db.lock();
        let _ = avail_api::db::build_logs::append(&conn, deployment_id, level, text, seq);
    }

    /// Picks up deployments no in-process caller enqueued directly — rows
    /// any process (this one's own poller, the Rust API, the Node API)
    /// inserted as `QUEUED`.
    async fn tick(self: &Arc<Self>) {
        let queued = {
            let conn = self.db.lock();
            deployments::queued(&conn).unwrap_or_default()
        };
        for deployment in queued {
            if self.running.lock().unwrap().contains_key(&deployment.id) {
                continue;
            }
            if self.running_projects.lock().unwrap().contains(&deployment.project_id) {
                continue;
            }
            let Ok(permit) = self.semaphore.clone().try_acquire_owned() else { continue };

            let cancel = CancellationToken::new();
            self.running.lock().unwrap().insert(deployment.id.clone(), cancel.clone());
            self.running_projects.lock().unwrap().insert(deployment.project_id.clone());

            let this = self.clone();
            let id = deployment.id.clone();
            let project_id = deployment.project_id.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(err) = this.execute(deployment, cancel).await {
                    logger::scoped("worker").error(format!("Build {id} crashed: {err}"));
                }
                this.running.lock().unwrap().remove(&id);
                this.running_projects.lock().unwrap().remove(&project_id);
            });
        }

        self.check_cancel_flags();
    }

    /// Cross-process cancellation: a build already running in this process
    /// aborts its own `CancellationToken` directly; one requested by
    /// another process (the Rust or Node API's `cancel` endpoint) instead
    /// flags the deployment's `meta` JSON, which this notices here.
    fn check_cancel_flags(&self) {
        let running = self.running.lock().unwrap().clone();
        if running.is_empty() {
            return;
        }
        let conn = self.db.lock();
        for (id, token) in running {
            if token.is_cancelled() {
                continue;
            }
            let Ok(Some(deployment)) = deployments::by_id(&conn, &id) else { continue };
            let Some(meta) = &deployment.meta else { continue };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(meta) else { continue };
            if parsed.get("cancelRequested").and_then(|v| v.as_bool()).unwrap_or(false) {
                token.cancel();
            }
        }
    }

    async fn execute(self: &Arc<Self>, deployment: Deployment, cancel: CancellationToken) -> Result<(), String> {
        if deployment.state == "CANCELED" {
            return Ok(());
        }
        let project = {
            let conn = self.db.lock();
            projects::by_id(&conn, &deployment.project_id).map_err(|e| e.to_string())?
        };
        let Some(project) = project else {
            let conn = self.db.lock();
            let _ = deployments::update(&conn, &deployment.id, &[
                ("state", rusqlite::types::Value::Text("ERROR".into())),
                ("error", rusqlite::types::Value::Text("Project no longer exists".into())),
            ]);
            return Ok(());
        };

        let started = db::now_ms();
        {
            let conn = self.db.lock();
            let _ = deployments::update(&conn, &deployment.id, &[
                ("state", rusqlite::types::Value::Text("INITIALIZING".into())),
                ("building_at", rusqlite::types::Value::Integer(started)),
            ]);
        }

        let (env, git_token) = {
            let conn = self.db.lock();
            let rows = env_vars::for_build(&conn, &project.id, &deployment.target, deployment.branch.as_deref()).unwrap_or_default();
            let mut env = HashMap::new();
            for row in rows.into_iter().rev() {
                if let Some(v) = self.crypto.try_decrypt(&row.value_enc, "env") {
                    env.insert(row.key, v);
                }
            }
            let token = match &project.git_integration_id {
                Some(gid) => integrations::by_id(&conn, gid).ok().flatten(),
                None => integrations::any(&conn).ok().flatten(),
            }
            .and_then(|i| self.crypto.try_decrypt(&i.token_enc, "git-token"));
            (env, token)
        };

        self.report_commit_status(&deployment, &project, &git_token, "pending", "Building…", &url_for(&self.config, &deployment.url)).await;

        let log = self.log_sink(deployment.id.clone());
        let this_for_phase = self.clone();
        let deployment_id_for_phase = deployment.id.clone();
        let on_phase = Box::new(move |phase: BuildPhase| {
            let conn = this_for_phase.db.lock();
            let _ = deployments::update(&conn, &deployment_id_for_phase, &[("state", rusqlite::types::Value::Text(phase_state(phase).into()))]);
        });

        let repo_url = if project.repo_provider.as_deref() == Some("local") { project.repo_full_name.clone() } else { None };

        let result = builder::run_build(
            &self.config,
            BuildInput {
                deployment: deployment.clone(),
                project: project.clone(),
                env,
                git_token: git_token.clone(),
                repo_url,
                log: log.clone(),
                cancel: cancel.clone(),
                on_phase,
            },
        )
        .await;

        match result {
            Ok(BuildOutcome::Skipped { commit }) => {
                self.publish_note("info", &deployment.id, "Ignore command exited 0 — build skipped");
                {
                    let conn = self.db.lock();
                    let _ = deployments::update(
                        &conn,
                        &deployment.id,
                        &[
                            ("state", rusqlite::types::Value::Text("SKIPPED".into())),
                            ("commit_sha", rusqlite::types::Value::Text(commit.sha.clone())),
                            ("build_duration_ms", rusqlite::types::Value::Integer(db::now_ms() - started)),
                            ("error", rusqlite::types::Value::Null),
                        ],
                    );
                }
                self.report_commit_status(&deployment, &project, &git_token, "success", "Build skipped (ignored)", &url_for(&self.config, &deployment.url)).await;
                Ok(())
            }
            Ok(BuildOutcome::Built(output)) => {
                {
                    let conn = self.db.lock();
                    let _ = deployments::update(
                        &conn,
                        &deployment.id,
                        &[
                            ("state", rusqlite::types::Value::Text("READY".into())),
                            ("framework", output.framework.clone().map(rusqlite::types::Value::Text).unwrap_or(rusqlite::types::Value::Null)),
                            ("serve_mode", rusqlite::types::Value::Text(output.serve_mode.clone())),
                            ("start_command", output.start_command.clone().map(rusqlite::types::Value::Text).unwrap_or(rusqlite::types::Value::Null)),
                            ("output_path", output.output_path.clone().map(rusqlite::types::Value::Text).unwrap_or(rusqlite::types::Value::Null)),
                            ("ready_at", rusqlite::types::Value::Integer(db::now_ms())),
                            ("build_duration_ms", rusqlite::types::Value::Integer(output.duration_ms)),
                            ("commit_sha", rusqlite::types::Value::Text(output.commit.sha.clone())),
                            (
                                "commit_message",
                                deployment.commit_message.clone().or(Some(output.commit.message.clone())).map(rusqlite::types::Value::Text).unwrap_or(rusqlite::types::Value::Null),
                            ),
                            (
                                "commit_author",
                                deployment.commit_author.clone().or(Some(output.commit.author.clone())).map(rusqlite::types::Value::Text).unwrap_or(rusqlite::types::Value::Null),
                            ),
                            ("error", rusqlite::types::Value::Null),
                        ],
                    );

                    if project.framework.is_none() {
                        if let Some(fw) = &output.framework {
                            let _ = projects::update(&conn, &project.id, &[
                                ("framework", rusqlite::types::Value::Text(fw.clone())),
                                ("serve_mode", rusqlite::types::Value::Text(output.serve_mode.clone())),
                            ]);
                        }
                    }
                }

                let assigned = self.assign_aliases(&deployment, &project);
                let assigned_full_urls: Vec<String> = assigned.iter().map(|h| url_for(&self.config, h)).collect();
                let assigned_urls = assigned_full_urls.join("  ");
                self.publish_note("info", &deployment.id, &format!("Deployment ready: {assigned_urls}"));

                self.report_commit_status(
                    &deployment,
                    &project,
                    &git_token,
                    "success",
                    "Deployment ready",
                    assigned_full_urls.first().map(String::as_str).unwrap_or(&deployment.url),
                )
                .await;
                self.comment_pr_ready(&deployment, &project, &git_token, &assigned_full_urls).await;

                {
                    let conn = self.db.lock();
                    let final_url = deployments::by_id(&conn, &deployment.id).ok().flatten().map(|d| d.url).unwrap_or_default();
                    let _ = events::record(
                        &conn,
                        events::NewEvent {
                            r#type: "deployment.ready",
                            text: &format!("Deployment ready at {}", url_for(&self.config, &final_url)),
                            project_id: Some(&project.id),
                            deployment_id: Some(&deployment.id),
                            user_id: None,
                        },
                    );
                    let _ = notifications::create(
                        &conn,
                        notifications::NewNotification {
                            user_id: &project.created_by,
                            r#type: "deployment_ready",
                            title: &format!("{} is ready", project.name),
                            body: Some(&url_for(&self.config, &final_url)),
                            project_id: Some(&project.id),
                            deployment_id: Some(&deployment.id),
                            transfer_id: None,
                            actor_id: None,
                        },
                    );
                }

                self.cleanup_old_deployments(&project);
                Ok(())
            }
            Err(message) => {
                let aborted = cancel.is_cancelled();
                self.publish_note("error", &deployment.id, &message);
                self.report_commit_status(
                    &deployment,
                    &project,
                    &git_token,
                    if aborted { "error" } else { "failure" },
                    if aborted { "Canceled" } else { "Build failed" },
                    &url_for(&self.config, &deployment.url),
                )
                .await;
                let conn = self.db.lock();
                let _ = deployments::update(
                    &conn,
                    &deployment.id,
                    &[
                        ("state", rusqlite::types::Value::Text(if aborted { "CANCELED" } else { "ERROR" }.into())),
                        ("error", rusqlite::types::Value::Text(message.clone())),
                        ("build_duration_ms", rusqlite::types::Value::Integer(db::now_ms() - started)),
                        ("ready_at", rusqlite::types::Value::Null),
                    ],
                );
                let _ = events::record(
                    &conn,
                    events::NewEvent {
                        r#type: if aborted { "deployment.canceled" } else { "deployment.error" },
                        text: &message,
                        project_id: Some(&project.id),
                        deployment_id: Some(&deployment.id),
                        user_id: None,
                    },
                );
                // A cancel was somebody's own doing (they clicked Cancel, or
                // redeployed over it) — no notification needed for a thing
                // they just did themselves. A real build failure is news.
                if !aborted {
                    let _ = notifications::create(
                        &conn,
                        notifications::NewNotification {
                            user_id: &project.created_by,
                            r#type: "deployment_error",
                            title: &format!("{} failed to build", project.name),
                            body: Some(&message),
                            project_id: Some(&project.id),
                            deployment_id: Some(&deployment.id),
                            transfer_id: None,
                            actor_id: None,
                        },
                    );
                }
                Ok(())
            }
        }
    }

    /// Best-effort GitHub feedback: a commit status check
    /// (`pending`/`success`/`failure`/`error`) on the commit being deployed.
    /// `create_commit_status` was ported from `apps/api`'s `github.ts`
    /// alongside everything else but never actually called — see
    /// docs/rust-api-migration-plan.md. Failing to reach GitHub never fails
    /// the deployment itself.
    async fn report_commit_status(
        &self,
        deployment: &Deployment,
        project: &Project,
        git_token: &Option<String>,
        state: &str,
        description: &str,
        target_url: &str,
    ) {
        if project.repo_provider.as_deref() != Some("github") {
            return;
        }
        let (Some(token), Some(full_name), Some(sha)) = (git_token, &project.repo_full_name, &deployment.commit_sha) else {
            return;
        };
        if let Err(err) =
            github::create_commit_status(&self.config.github.api_url, token, full_name, sha, state, target_url, description, "avail-deploy").await
        {
            logger::scoped("worker").warn(format!("GitHub commit status ({state}) failed for {}: {err}", deployment.id));
        }
    }

    /// Best-effort "preview ready" comment on the pull request a preview
    /// deployment was built for. `comment_on_pull_request` has the same
    /// history as `report_commit_status` above.
    async fn comment_pr_ready(&self, deployment: &Deployment, project: &Project, git_token: &Option<String>, urls: &[String]) {
        if project.repo_provider.as_deref() != Some("github") {
            return;
        }
        let (Some(token), Some(full_name), Some(pr_number)) = (git_token, &project.repo_full_name, deployment.pr_number) else {
            return;
        };
        let sha = deployment.commit_sha.as_deref().unwrap_or("");
        let short_sha = &sha[..sha.len().min(7)];
        let body = format!(
            "**Deploy Preview for _{}_ ready!**\n\nBuilt with Avail Deploy from commit {short_sha}.\n\n| Name | Status | Preview |\n| :--- | :--- | :--- |\n| **{}** | ✅ Ready | {} |",
            project.name,
            project.name,
            urls.first().map(String::as_str).unwrap_or("—"),
        );
        if let Err(err) = github::comment_on_pull_request(&self.config.github.api_url, token, full_name, pr_number, &body).await {
            logger::scoped("worker").warn(format!("GitHub PR comment failed for {}: {err}", deployment.id));
        }
    }

    /// Points the branch alias (and, for production deployments, the
    /// project's production domain) at a finished deployment.
    fn assign_aliases(&self, deployment: &Deployment, project: &avail_api::db::types::Project) -> Vec<String> {
        let conn = self.db.lock();
        let mut assigned = vec![deployment.url.clone()];
        let now = db::now_ms();

        if let Some(branch) = &deployment.branch {
            let host = branch_host(&self.config, &project.slug, branch);
            let _ = avail_api::db::aliases::upsert(&conn, &avail_api::db::types::Alias {
                id: new_alias_id(),
                domain: host.clone(),
                project_id: project.id.clone(),
                deployment_id: Some(deployment.id.clone()),
                r#type: "branch".to_string(),
                created_at: now,
                updated_at: now,
            });
            assigned.push(host);
        }

        if deployment.target == "production" {
            let host = production_host(&self.config, &project.slug);
            let _ = avail_api::db::aliases::upsert(&conn, &avail_api::db::types::Alias {
                id: new_alias_id(),
                domain: host.clone(),
                project_id: project.id.clone(),
                deployment_id: Some(deployment.id.clone()),
                r#type: "production".to_string(),
                created_at: now,
                updated_at: now,
            });
            let _ = deployments::promote(&conn, &project.id, &deployment.id);
            assigned.push(host);
        }

        assigned
    }

    /// Frees disk by dropping build artifacts of superseded deployments.
    /// Same reasoning as `builder::spawn_deployment_cleanup`: the actual
    /// disk removal is slow (WSL UNC paths, large `node_modules`
    /// snapshots) and used to run synchronously while holding `self.db`'s
    /// lock — which, unlike avail-api's, only blocks this one process, but
    /// still meant one slow cleanup could stall `tick()` from picking up
    /// the next queued build for however long the removal took.
    fn cleanup_old_deployments(&self, project: &avail_api::db::types::Project) {
        let stale_ids: Vec<String> = {
            let conn = self.db.lock();
            deployments::stale_for_project(&conn, &project.id, self.config.build.keep_per_project)
                .unwrap_or_default()
                .into_iter()
                .filter(|d| d.output_path.is_some())
                .map(|d| d.id)
                .collect()
        };
        if stale_ids.is_empty() {
            return;
        }
        let deployments_dir = self.config.deployments_dir.clone();
        let db = self.db.clone();
        tokio::spawn(async move {
            for id in &stale_ids {
                let dir = deployments_dir.join(id);
                let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir)).await;
            }
            let conn = db.lock();
            for id in &stale_ids {
                let _ = deployments::update(&conn, id, &[("output_path", rusqlite::types::Value::Null)]);
            }
        });
    }

    /// Recovers deployments that were mid-flight when this process last
    /// stopped: queued builds resume (naturally, on the next `tick`),
    /// in-progress ones are marked failed.
    fn recover_on_boot(&self) {
        let conn = self.db.lock();
        for d in deployments::active(&conn).unwrap_or_default() {
            if d.state == "QUEUED" {
                continue;
            }
            let _ = deployments::update(&conn, &d.id, &[
                ("state", rusqlite::types::Value::Text("ERROR".into())),
                ("error", rusqlite::types::Value::Text("Build interrupted by a platform restart".into())),
            ]);
        }
    }
}

#[tokio::main]
async fn main() {
    let log = logger::scoped("worker");
    let cfg = config::load();
    let db = Db::open(&cfg.db_file).expect("open sqlite database");
    let concurrency = cfg.build.concurrency.max(1) as usize;

    let worker = Arc::new(Worker {
        crypto: Crypto::new(cfg.secret.clone()),
        running: Mutex::new(HashMap::new()),
        running_projects: Mutex::new(HashSet::new()),
        semaphore: Arc::new(Semaphore::new(concurrency)),
        db,
        config: cfg,
    });

    worker.recover_on_boot();

    log.info("Build worker started (avail-worker, no Node process involved)");
    log.info(format!("Database: {}", worker.config.db_file.display()));
    log.info(format!("Build executor: {}", worker.config.build.executor));
    log.info(format!("Build workspace: {} ({})", worker.config.workspace_dir.display(), worker.config.workspace_reason));
    log.info("Picking up QUEUED deployments every 1s, from any process that inserts one");

    let (ok, detail) = builder::check_executor(&worker.config).await;
    if ok {
        log.info(format!("Executor check: ok ({})", detail.lines().next().unwrap_or("")));
    } else {
        log.warn(format!("Executor check failed: {detail}"));
    }

    loop {
        worker.tick().await;
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}
